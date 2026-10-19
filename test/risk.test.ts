import assert from "node:assert/strict";
import { test } from "node:test";
import { labelTool, words } from "../src/risk.ts";

const classes = (name: string, extra: Record<string, unknown> = {}) => labelTool({ name, ...extra }).classes.join("+");

test("names are split the same way whatever their style", () => {
  for (const name of ["createIssue", "create_issue", "create-issue", "create.issue"]) assert.deepEqual(words(name), ["create", "issue"]);
});

test("the verb is found by position, so nouns that look like verbs do not mislead", () => {
  const expected: Record<string, string> = {
    get_job_logs: "read", list_pull_requests: "read", search_pull_requests: "read", pull_request_read: "read", issues: "",
    issue_write: "write", github_create_issue: "write", add_issue_comment: "write", log_event: "write",
    delete_file: "destructive", drop_database_schema: "destructive", repo_webhook_delete: "destructive",
    slack_send_message: "send", send_invoice: "send+money",
    create_refund: "write+money", pay_invoice: "write+money", list_payments: "read", get_balance: "read",
    "database.customer.read": "read", "finance.refund.create": "write+money",
  };
  for (const [name, label] of Object.entries(expected)) assert.equal(classes(name), label, name);
});

test("where no word qualifies there is no guess, and the description is tried before giving up", () => {
  assert.deepEqual(labelTool({ name: "wubble_frobnicate_request" }), { classes: [], source: "unclassified", basis: [] });
  const fromDescription = labelTool({ name: "weather", description: "Returns the forecast for a city. Then more text." });
  assert.equal(fromDescription.source, "heuristic");
  assert.deepEqual(fromDescription.classes, ["read"]);
});

test("a server's annotations decide between reading and writing, and the label says so", () => {
  assert.deepEqual(labelTool({ name: "delete_everything", annotations: { readOnlyHint: true } }).classes, ["read"]);
  assert.equal(labelTool({ name: "delete_everything", annotations: { readOnlyHint: true } }).source, "mcp_annotation");
  assert.deepEqual(labelTool({ name: "sync", annotations: { readOnlyHint: false } }).classes, ["write"]);
  assert.deepEqual(labelTool({ name: "sync", annotations: { readOnlyHint: false, destructiveHint: true } }).classes, ["destructive"]);
  // Annotations cannot say "sends" or "moves money", so the name adds those.
  assert.deepEqual(labelTool({ name: "create_refund", annotations: { readOnlyHint: false } }).classes, ["write", "money"]);
  assert.deepEqual(labelTool({ name: "send_email", annotations: { readOnlyHint: false } }).classes, ["send"]);
});

test("an annotation that says only 'not read-only' does not hide that a tool deletes", () => {
  assert.deepEqual(labelTool({ name: "delete_file", annotations: { readOnlyHint: false } }).classes, ["destructive"]);
  // The server says outright that it does not destroy: the label follows, and a finding says the name disagrees.
  assert.deepEqual(labelTool({ name: "delete_repository", annotations: { destructiveHint: false } }).classes, ["write"]);
});

test("a word that acts outranks a word that reads, wherever it stands", () => {
  const expected: Record<string, string> = {
    load_balancer_delete: "destructive", list_remove_member: "destructive", monitor_delete: "destructive", review_comment_delete: "destructive",
    audit_log_purge: "destructive", search_and_delete: "destructive", status_update: "write", check_run_create: "write",
    get_or_create_user: "write", browse_and_purchase: "write+money", seed_database: "write",
    mark_all_notifications_read: "write", set_message_read: "write", issue_read: "read", purchase_history_list: "read", log_event: "write",
  };
  for (const [name, label] of Object.entries(expected)) assert.equal(classes(name), label, name);
});

test("the description is read the same way: any acting word decides", () => {
  assert.deepEqual(labelTool({ name: "issues", description: "List, create, update or delete issues" }).classes, ["destructive"]);
  assert.deepEqual(labelTool({ name: "cleanup", description: "Use this to remove items the user no longer wants to see" }).classes, ["destructive"]);
  assert.deepEqual(labelTool({ name: "logs", description: "Returns recent log lines." }).classes, ["read"]);
});

test("a free-form target is marked broad, from the name or a parameter", () => {
  assert.equal(labelTool({ name: "execute_sql" }).broad, true);
  assert.equal(labelTool({ name: "run", inputSchema: { type: "object", properties: { command: { type: "string" } } } }).broad, true);
  assert.equal(labelTool({ name: "search_code", inputSchema: { type: "object", properties: { query: { type: "string" } } } }).broad, undefined);
});

test("moving money is read off a money word beside an action, not off a bare banking verb", () => {
  const money = (name: string) => labelTool({ name }).classes.includes("money");
  for (const name of ["send_money", "create_transaction", "void_transaction", "settle_transaction", "settle_up", "capture_payment", "void_invoice"]) assert.ok(money(name), name);
  for (const name of ["void_envelope", "capture_screenshot", "list_transactions"]) assert.ok(!money(name), name);
});

test("a description is read for what it says the tool does, not for every acting word in it", () => {
  // Found in the tracker's published vendors (CircleCI, Linear, Grafana, Zapier, Supabase): read-only
  // getters that were counted as acting because of a word describing the thing they read.
  const said = (description: string) => labelTool({ name: "x", description }).classes.join("+");
  const reads: string[] = [
    "Fetch an orb's metadata and published version history",
    "Validate a pipeline config by compiling it",
    "List all permissions set on a resource",
    "Fetch annotations using filters such as time range and tags",
    "List a team's cycles with their dates, and issue and scope histories",
    "Gets the cost of creating a new project or branch",
    "Returns the URL where users can configure it - adding, editing, or removing actions",
    "Recursively resolve an entry's references and return the entry plus its linked assets",
    "Read the catalog: which agents send data where",
  ];
  for (const description of reads) assert.equal(said(description), "read", description);
  // Waiting reads; the thing waited for does not act ("to settle" is said of the investigation).
  assert.equal(said("Wait for an investigation to settle"), "read");
  // Words that do say what the tool does still count, wherever the sentence puts them.
  const acts: Record<string, string> = {
    "List, create, update or delete issues": "destructive",
    "Use this to remove items the user no longer wants": "destructive",
    "This tool sends a message to the channel": "send",
    "Fetches the record and deletes it": "destructive",
    "Fetches the record and then optionally deletes it": "destructive",
    "Creates a branch, which can incur usage charges": "write+money",
    "Executes a query against the datasource": "write",
    "Runs a query against the logs": "write",
    "Apply a template to an issue": "write",
    "Fetch an orb and publish a new version of it": "send",
    "List comments and share them with the team": "send",
  };
  for (const [description, label] of Object.entries(acts)) assert.equal(said(description), label, description);
  // A sentence that does not open by saying the tool reads is read whole, as it always was, so
  // an acting word anywhere in it counts. Each of these lost its label in a first draft of the rule.
  const whole: Record<string, string> = {
    "A tool that deletes files from the workspace": "destructive",
    "Tool for deleting files": "destructive",
    "Can be used to delete files": "destructive",
    "Allows users to delete files": "destructive",
    "Enables you to delete files": "destructive",
    "Given a path, deletes the file": "destructive",
    "When called, permanently deletes the repository": "destructive",
    "Perform a hard delete of the record": "destructive",
    "Unpublish an entry to remove it": "destructive",
    "[Destructive] Deletes a branch": "destructive",
    "Handles creating, updating and deleting issues": "destructive",
    "Executes any API call including DELETE operations": "destructive",
    "Write data via any POST/PATCH/PUT/DELETE operation": "destructive",
    "Run SQL that may drop tables": "destructive",
    "Gmail: send an email to a recipient": "send",
    "Wrapper around the Slack API to send messages": "send",
    // Opening with a read, a verb joined on by a comma or after "to" still counts.
    "Fetch a user, update their email": "write",
    "Fetch the stale records to purge them": "destructive",
    "Lists files, deleting those older than 30 days": "destructive",
    "Test the webhook by sending a sample event": "send",
    "Call an external webhook with the payload": "write",
  };
  for (const [description, label] of Object.entries(whole)) assert.equal(said(description), label, description);
});

test("a name's acting word used as a thing does not make a reader act", () => {
  const expected: Record<string, string> = {
    get_deploy_component: "read", list_deploy_components: "read", list_deploy_component_versions: "read",
    get_status_updates: "read", list_payment_refunds: "read",
    deploy_app: "write", create_deploy: "write", trigger_deploy: "write", deploy: "write",
    send_invites: "send", list_and_send_updates: "send",
    // A destructive word is never read as a thing.
    list_pending_deletes: "destructive", purge_old_logs: "destructive",
    // Only a name that opens with a plain read verb reads the words after it as the thing read.
    app_deploy: "write", vercel_deploy: "write", app_deploys: "write", bulk_updates: "write", batch_inserts: "write",
    records_bulk_creates: "write", zap_executes: "write", sheet_values_appends: "write", bot_sends_message: "send",
    read_write_file: "write", get_or_create_user: "write",
    // Past a read verb only a plural is a thing; a singular acting word still acts.
    get_user_update_profile: "write", find_user_send_message: "send", read_file_then_execute: "write",
    list_messages_mark_read: "write", fetch_email_send: "send", describe_stack_update: "write",
    vercel_deploy_project: "write", netlify_deploy_site: "write",
  };
  for (const [name, label] of Object.entries(expected)) assert.equal(classes(name), label, name);
});
