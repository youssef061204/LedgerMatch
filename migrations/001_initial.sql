CREATE TABLE workspaces (id uuid PRIMARY KEY, name text NOT NULL, currency text NOT NULL DEFAULT 'CAD' CHECK(currency='CAD'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE principals (id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE memberships (workspace_id uuid REFERENCES workspaces(id), principal_id uuid REFERENCES principals(id), role text NOT NULL CHECK(role IN ('reviewer','viewer')), PRIMARY KEY(workspace_id,principal_id));
CREATE TABLE sessions (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, principal_id uuid NOT NULL, expires_at timestamptz NOT NULL, FOREIGN KEY(workspace_id,principal_id) REFERENCES memberships(workspace_id,principal_id));
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE imports (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), type text NOT NULL CHECK(type IN ('invoice','payment')), filename text NOT NULL, hash text NOT NULL, row_count integer NOT NULL, skipped integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'imported', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,type,hash), UNIQUE(workspace_id,id));
CREATE TABLE import_rows (import_id uuid NOT NULL REFERENCES imports(id), row_number integer NOT NULL, record_id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(import_id,row_number));
CREATE TABLE invoices (workspace_id uuid NOT NULL REFERENCES workspaces(id), id text NOT NULL, customer_id text NOT NULL, invoice_date date NOT NULL, due_date date NOT NULL, amount bigint NOT NULL CHECK(amount>0 AND amount<=10000000000), currency text NOT NULL CHECK(currency='CAD'), import_id uuid NOT NULL, PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,import_id) REFERENCES imports(workspace_id,id));
CREATE TABLE payments (workspace_id uuid NOT NULL REFERENCES workspaces(id), id text NOT NULL, customer_id text, payment_date date NOT NULL, amount bigint NOT NULL CHECK(amount>0 AND amount<=10000000000), currency text NOT NULL CHECK(currency='CAD'), reference text, review_status text NOT NULL DEFAULT 'pending', explanation text NOT NULL DEFAULT 'Run reconciliation to review this payment.', candidates jsonb NOT NULL DEFAULT '[]', import_id uuid NOT NULL, PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,import_id) REFERENCES imports(workspace_id,id));
CREATE INDEX invoices_customer ON invoices(workspace_id,customer_id);
CREATE INDEX payments_review ON payments(workspace_id,review_status,payment_date,id);
CREATE TABLE runs (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), principal_id uuid NOT NULL, status text NOT NULL CHECK(status IN ('queued','running','completed','failed')), processed integer NOT NULL DEFAULT 0, total integer NOT NULL DEFAULT 0, rule_version text NOT NULL, job_id uuid, attempts integer NOT NULL DEFAULT 0, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(workspace_id,principal_id) REFERENCES memberships(workspace_id,principal_id), UNIQUE(workspace_id,id));
CREATE UNIQUE INDEX one_live_run ON runs(workspace_id) WHERE status IN ('queued','running');
CREATE TABLE allocations (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), payment_id text NOT NULL, invoice_id text NOT NULL, amount bigint NOT NULL CHECK(amount>0), source text NOT NULL CHECK(source IN ('automatic','manual')), rule_version text, explanation text NOT NULL, evidence jsonb NOT NULL, run_id uuid, created_at timestamptz NOT NULL DEFAULT now(), reversed_at timestamptz, reversal_note text, FOREIGN KEY(workspace_id,payment_id) REFERENCES payments(workspace_id,id), FOREIGN KEY(workspace_id,invoice_id) REFERENCES invoices(workspace_id,id), FOREIGN KEY(workspace_id,run_id) REFERENCES runs(workspace_id,id), CHECK((reversed_at IS NULL AND reversal_note IS NULL) OR (reversed_at IS NOT NULL AND length(trim(reversal_note))>0)));
CREATE UNIQUE INDEX one_active_payment_allocation ON allocations(workspace_id,payment_id) WHERE reversed_at IS NULL;
CREATE INDEX invoice_active_allocations ON allocations(workspace_id,invoice_id) WHERE reversed_at IS NULL;
CREATE TABLE decisions (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, principal_id uuid NOT NULL, payment_id text NOT NULL, allocation_id uuid REFERENCES allocations(id), action text NOT NULL, note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(workspace_id,principal_id) REFERENCES memberships(workspace_id,principal_id), FOREIGN KEY(workspace_id,payment_id) REFERENCES payments(workspace_id,id));
CREATE TABLE audit_events (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), actor text NOT NULL, action text NOT NULL, entity_id text NOT NULL, explanation text NOT NULL, changes jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_workspace_date ON audit_events(workspace_id,created_at DESC,id);
CREATE FUNCTION guard_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i invoices; p payments; total bigint;
BEGIN
  PERFORM 1 FROM workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  IF TG_OP='UPDATE' THEN
    IF OLD.reversed_at IS NOT NULL OR NEW.reversed_at IS NULL OR (to_jsonb(NEW)-'reversed_at'-'reversal_note') IS DISTINCT FROM (to_jsonb(OLD)-'reversed_at'-'reversal_note') THEN
      RAISE EXCEPTION 'Allocation evidence is immutable; only a first reversal is allowed';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO i FROM invoices WHERE workspace_id=NEW.workspace_id AND id=NEW.invoice_id FOR UPDATE;
  SELECT * INTO p FROM payments WHERE workspace_id=NEW.workspace_id AND id=NEW.payment_id FOR UPDATE;
  IF i.id IS NULL OR p.id IS NULL OR i.currency<>p.currency OR NEW.amount<>p.amount OR (p.customer_id IS NOT NULL AND p.customer_id<>i.customer_id) THEN RAISE EXCEPTION 'Allocation violates workspace, currency, customer or full payment constraint'; END IF;
  SELECT coalesce(sum(amount),0) INTO total FROM allocations WHERE workspace_id=NEW.workspace_id AND invoice_id=NEW.invoice_id AND reversed_at IS NULL;
  IF NEW.amount+total>i.amount THEN RAISE EXCEPTION 'Allocation exceeds invoice outstanding balance'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER allocation_guard BEFORE INSERT OR UPDATE ON allocations FOR EACH ROW EXECUTE FUNCTION guard_allocation();
CREATE FUNCTION reject_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Historical evidence cannot be changed or deleted'; END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_evidence_change();
CREATE TRIGGER decision_immutable BEFORE UPDATE OR DELETE ON decisions FOR EACH ROW EXECUTE FUNCTION reject_evidence_change();
CREATE TRIGGER allocation_no_delete BEFORE DELETE ON allocations FOR EACH ROW EXECUTE FUNCTION reject_evidence_change();
CREATE VIEW invoice_balances AS SELECT i.*, coalesce(a.paid,0)::bigint AS paid, (i.amount-coalesce(a.paid,0))::bigint AS outstanding, CASE WHEN coalesce(a.paid,0)=i.amount THEN 'paid' WHEN coalesce(a.paid,0)>0 THEN 'partial' ELSE 'unpaid' END AS status FROM invoices i LEFT JOIN (SELECT workspace_id,invoice_id,sum(amount) AS paid FROM allocations WHERE reversed_at IS NULL GROUP BY workspace_id,invoice_id) a ON a.workspace_id=i.workspace_id AND a.invoice_id=i.id;
