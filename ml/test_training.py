"""Tests for selection/calibration/export behavior, independent of the final test set."""
import unittest
import numpy as np
from train import fit_linear, linear_export, thresholds, grouped_scores, export_trees
import xgboost as xgb


class TrainingTests(unittest.TestCase):
    def test_folded_preprocessing_preserves_predictions(self):
        x = np.asarray([[i, i % 3, i / 100] for i in range(100)])
        y = np.asarray([int(i > 40) for i in range(100)])
        pipeline = fit_linear(x, y)
        exported = linear_export(pipeline)
        np.testing.assert_allclose(pipeline.decision_function(x), x @ exported['coefficients'] + exported['intercept'], atol=1e-12)

    def test_thresholds_include_whole_ties_and_reject_insufficient_evidence(self):
        rows = [{'n': 2, 'correct': int(i < 90), 'group': {'status': 'needs_review'}} for i in range(100)]
        self.assertEqual(thresholds(rows, [0.9] * 100, 0.99)['accepted'], 0)
        self.assertEqual(thresholds(rows, [0.9] * 100, 0.9)['accepted'], 100)
        self.assertEqual(thresholds(rows[:40], [0.99] * 40, 0.99)['threshold'], 1.01)

    def test_review_holds_are_excluded_from_acceptance(self):
        rows = [{'n': 2, 'correct': 1, 'group': {'status': 'suspected_duplicate'}} for _ in range(100)]
        self.assertEqual(thresholds(rows, [1.0] * 100, 0.99)['accepted'], 0)

    def test_groups_keep_empty_and_negative_cases(self):
        groups = [{'x': [], 'candidates': [], 'y': []}, {'x': [[0], [0]], 'candidates': [{'invoiceId': 'B'}, {'invoiceId': 'A'}], 'y': [0, 0]}]
        result = grouped_scores(groups, np.asarray([0.5, 0.5]))
        self.assertEqual([r['correct'] for r in result], [0, 0])
        self.assertEqual(result[1]['context'][1], 0)

    def test_exported_tree_format_covers_all_nodes(self):
        x = np.arange(100, dtype=np.float32).reshape(-1, 1)
        model = xgb.XGBClassifier(n_estimators=3, max_depth=2, base_score=0.5, n_jobs=1).fit(x, (x[:, 0] > 40).astype(int))
        exported = export_trees(model)
        self.assertEqual(len(exported['trees']), 3)
        for tree in exported['trees']:
            self.assertEqual(len({len(v) for v in tree.values()}), 1)
            self.assertIn(-1, tree['feature'])


if __name__ == '__main__':
    unittest.main()
