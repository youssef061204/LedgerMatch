"""Offline training. Deliberately never opens test.jsonl or robustness.jsonl."""
import argparse
import hashlib
import json
import platform
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import sklearn
import xgboost as xgb
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


def read_groups(path):
    with path.open(encoding="utf-8") as source:
        return [g for line in source if (g := json.loads(line))["route"] == "exception"]


def matrix(groups):
    return np.asarray([row for g in groups for row in g["x"]], dtype=np.float32), np.asarray([y for g in groups for y in g["y"]])


def linear_export(pipeline):
    scaler, model = pipeline.steps[0][1], pipeline.steps[1][1]
    coef = model.coef_[0] / scaler.scale_
    return {"coefficients": coef.tolist(), "intercept": float(model.intercept_[0] - np.dot(coef, scaler.mean_))}


def fit_linear(x, y):
    return make_pipeline(StandardScaler(), LogisticRegression(C=1, max_iter=2000, random_state=42)).fit(x, y)


def grouped_scores(groups, predictions):
    result, offset = [], 0
    for group in groups:
        n = len(group["x"])
        values = predictions[offset:offset+n]
        offset += n
        order = sorted(range(n), key=lambda i: (-float(values[i]), group["candidates"][i]["invoiceId"]))
        top = float(values[order[0]]) if n else 0
        gap = top - float(values[order[1]]) if n > 1 else 0
        correct = int(n > 0 and group["y"][order[0]] == 1)
        result.append({"context": [top, gap, float(np.log1p(n))], "correct": correct, "n": n, "group": group})
    assert offset == len(predictions)
    return result


def top1(rows):
    eligible = [r for r in rows if r["group"]["validMatchExists"]]
    return sum(r["correct"] for r in eligible) / len(eligible) if eligible else 0


def thresholds(rows, probabilities, target):
    eligible = [(float(p), r["correct"]) for r, p in zip(rows, probabilities) if r["n"] and r["group"]["status"] not in HOLD_STATUSES]
    eligible.sort(reverse=True)
    best = {"target": target, "threshold": 1.01, "accepted": 0, "precision": None, "coverage": 0}
    correct = 0
    for i, (probability, y) in enumerate(eligible):
        correct += y
        if i + 1 < len(eligible) and eligible[i+1][0] == probability:
            continue
        if i + 1 >= 50 and correct / (i+1) >= target:
            best = {"target": target, "threshold": probability, "accepted": i+1, "precision": correct/(i+1), "coverage": (i+1)/len(rows)}
    return best


HOLD_STATUSES = {"suspected_duplicate", "ambiguous_reference", "customer_mismatch", "currency_mismatch", "overpayment", "invoice_paid", "reversed", "deferred"}


def export_trees(model):
    trees = []
    for dumped in model.get_booster().get_dump(dump_format="json"):
        nodes = {}
        def visit(node):
            nodes[node["nodeid"]] = node
            for child in node.get("children", []):
                visit(child)
        visit(json.loads(dumped))
        n = max(nodes) + 1
        tree = {k: [0] * n for k in ["feature", "threshold", "left", "right", "value"]}
        for i, node in nodes.items():
            if "leaf" in node:
                tree["feature"][i] = -1
                tree["value"][i] = node["leaf"]
            else:
                tree["feature"][i] = int(node["split"][1:])
                tree["threshold"][i] = node["split_condition"]
                tree["left"][i] = node["yes"]
                tree["right"][i] = node["no"]
        trees.append(tree)
    return {"kind": "boosted", "baseMargin": 0, "trees": trees}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default=".local/ml-data")
    parser.add_argument("--output", default="models")
    args = parser.parse_args()
    directory, output = Path(args.data), Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((directory / "manifest.json").read_text())
    for split in ["train", "validation"]:
        assert hashlib.sha256((directory / f"{split}.jsonl").read_bytes()).hexdigest() == manifest["files"][split]
    train = read_groups(directory / "train.jsonl")
    validation = read_groups(directory / "validation.jsonl")
    partitions = {role: [g for g in validation if g["validationRole"] == role] for role in ["selection", "calibration", "threshold"]}
    sets = [set(g["cohort"] for g in groups) for groups in [train, *partitions.values()]]
    assert all(not a.intersection(b) for i, a in enumerate(sets) for b in sets[i+1:]), "Cohort leakage"
    x_train, y_train = matrix(train)
    matrices = {role: matrix(groups)[0] for role, groups in partitions.items()}
    logistic = fit_linear(x_train, y_train)
    trials, best, best_score = [], None, -1
    for depth in [3, 5]:
        model = xgb.XGBClassifier(n_estimators=120, max_depth=depth, learning_rate=0.08, objective="binary:logistic", base_score=0.5, tree_method="hist", n_jobs=4, random_state=manifest["seed"], subsample=1, colsample_bytree=1, eval_metric="logloss")
        model.fit(x_train, y_train)
        score = top1(grouped_scores(partitions["selection"], model.predict(matrices["selection"], output_margin=True)))
        trials.append({"max_depth": depth, "estimators": 120, "validation_top1": score})
        if score > best_score:
            best, best_score = model, score
    predictors = {"heuristic": {"kind": "heuristic"}, "logistic": {"kind": "linear", **linear_export(logistic)}, "xgboost": export_trees(best)}
    def predict(name, x):
        if name == "heuristic": return x[:, 24]
        if name == "logistic": return logistic.decision_function(x)
        return best.predict(x, output_margin=True)
    models, parity = {}, []
    for name, predictor in predictors.items():
        cal_rows = grouped_scores(partitions["calibration"], predict(name, matrices["calibration"]))
        nonempty = [r for r in cal_rows if r["n"]]
        calibration = fit_linear(np.asarray([r["context"] for r in nonempty]), np.asarray([r["correct"] for r in nonempty]))
        threshold_rows = grouped_scores(partitions["threshold"], predict(name, matrices["threshold"]))
        probabilities = calibration.predict_proba(np.asarray([r["context"] for r in threshold_rows]))[:, 1]
        table = [thresholds(threshold_rows, probabilities, target) for target in [0.99, 0.98, 0.95]]
        models[name] = {"predictor": predictor, "calibration": linear_export(calibration), "threshold": table[0]["threshold"], "precisionTargets": table}
        # Native predictions from validation, used to test portable Node execution.
        probe_rows = matrices["selection"][::max(1, len(matrices["selection"])//256)][:256]
        parity.append({"model": name, "x": probe_rows.tolist(), "predictions": predict(name, probe_rows).tolist()})
    metadata = {"createdAt": datetime.now(timezone.utc).isoformat(), "python": platform.python_version(), "numpy": np.__version__, "scikitLearn": sklearn.__version__, "xgboost": xgb.__version__, "node": subprocess.check_output(["node", "--version"], text=True).strip(), "gitCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(), "dataset": manifest, "selectionTrials": trials, "validationRoles": {k: len(v) for k, v in partitions.items()}, "trainPairs": len(y_train), "trainPositivePairs": int(y_train.sum()), "objective": "binary:logistic; rank compatible pairs; calibrate top-choice correctness", "preprocessing": "Shared TypeScript float32 features; exported logistic scaling folded into coefficients; tree base_score=0.5", "defaultThresholdPolicy": "Maximum coverage at empirical 99% precision with at least 50 accepted threshold-validation groups; 1.01 disables acceptance when unsupported", "calibration": "Platt-style logistic calibration on top raw score, top/second margin and log1p(candidate count); separate validation cohorts", "testAccess": "Training does not open test or robustness data"}
    model_id = "lm-" + hashlib.sha256(json.dumps(models, sort_keys=True).encode()).hexdigest()[:16]
    bundle = {"version": "1.0.0", "featureVersion": manifest["featureVersion"], "featureNames": manifest["features"], "modelId": model_id, "selected": "xgboost", "models": models, "metadata": metadata}
    (output / "ranker.json").write_text(json.dumps(bundle, separators=(",", ":")) + "\n", encoding="utf-8")
    (output / "parity.json").write_text(json.dumps(parity, separators=(",", ":")) + "\n", encoding="utf-8")
    best.save_model(output / "xgboost-native.json")
    print(json.dumps({"modelId": model_id, "selectionTrials": trials, "thresholds": {k: v["precisionTargets"] for k, v in models.items()}}, indent=2))


if __name__ == "__main__":
    main()
