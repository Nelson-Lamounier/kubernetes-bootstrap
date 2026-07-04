#!/usr/bin/env python3
"""Close the observability gaps on the `database` Grafana dashboard.

1. Introduce a `rds_instance` dashboard variable (default k8s-dev-platform-rds-iso)
   and repoint every CloudWatch metric dimension + log group at it, so a future
   instance rename cannot silently break the panels again.
2. Append the missing rows: compute & burst credits, throughput & network,
   Performance Insights DB load, live-SQL Postgres engine health, PgBouncer
   traffic & wait, and connection failures.

Idempotent: re-running replaces the generated rows (matched by the marker tag).
"""
import json, sys, pathlib

DASH = pathlib.Path(__file__).resolve().parents[1] / "charts/monitoring/chart/dashboards/database.json"
INSTANCE = "k8s-dev-platform-rds-iso"
VAR = "${rds_instance}"
REGION = "eu-west-1"
CW = {"type": "cloudwatch", "uid": "cloudwatch"}
PG = {"type": "postgres", "uid": "rds-postgres"}
PROM = {"type": "prometheus", "uid": "prometheus"}
MARK = "gen:rds-gaps"  # tag on generated rows so re-runs are idempotent

d = json.loads(DASH.read_text())

# ── 1. variable ───────────────────────────────────────────────────────────────
tlist = d.setdefault("templating", {}).setdefault("list", [])
if not any(v.get("name") == "rds_instance" for v in tlist):
    tlist.insert(0, {
        # custom (not constant): constant variables do not interpolate reliably
        # in provisioned-JSON dashboards under GitOps, leaking the literal
        # "${rds_instance}" into CloudWatch dimensions -> silent "No data".
        "name": "rds_instance", "type": "custom", "label": "RDS instance",
        "query": INSTANCE,
        "options": [{"text": INSTANCE, "value": INSTANCE, "selected": True}],
        "current": {"text": INSTANCE, "value": INSTANCE, "selected": True},
        "includeAll": False, "multi": False,
        "hide": 2, "skipUrlSync": False,
        "description": "RDS DBInstanceIdentifier — change here on a rename",
    })

# ── 2. repoint existing panels at the variable ───────────────────────────────
def repoint(node):
    if isinstance(node, dict):
        if node.get("dimensions", {}).get("DBInstanceIdentifier"):
            node["dimensions"]["DBInstanceIdentifier"] = VAR
        for lg in node.get("logGroups", []) or []:
            lg["name"] = f"/aws/rds/instance/{VAR}/postgresql"
            lg["arn"] = f"arn:aws:logs:{REGION}:771826808455:log-group:/aws/rds/instance/{VAR}/postgresql:*"
        for v in node.values():
            repoint(v)
    elif isinstance(node, list):
        for v in node:
            repoint(v)

repoint(d["panels"])

# ── 3. drop any previously generated rows (idempotency) ──────────────────────
d["panels"] = [p for p in d["panels"] if MARK not in (p.get("tags") or [])]

# ── panel builders ───────────────────────────────────────────────────────────
_id = [max([p.get("id", 0) for p in d["panels"]] + [605])]
def nid():
    _id[0] += 1
    return _id[0]

LETTERS = "ABCDEFGH"
def cw(metrics, stat="Average"):
    return [{"refId": LETTERS[i], "namespace": "AWS/RDS", "metricName": m,
             "statistic": stat, "region": REGION, "matchExact": True,
             "dimensions": {"DBInstanceIdentifier": VAR}} for i, m in enumerate(metrics)]

def ts_cw(title, metrics, unit="short", stat="Average", desc="", thresholds=None):
    fc = {"defaults": {"unit": unit, "min": 0, "custom": {"fillOpacity": 8, "lineWidth": 2}}}
    if thresholds:
        fc["defaults"]["thresholds"] = {"mode": "absolute", "steps": thresholds}
        fc["defaults"]["custom"]["thresholdsStyle"] = {"mode": "dashed"}
    return {"id": nid(), "type": "timeseries", "title": title, "datasource": CW,
            "description": desc, "fieldConfig": fc, "targets": cw(metrics, stat), "tags": [MARK]}

def ts_prom(title, exprs, unit="short", desc=""):
    tg = [{"refId": LETTERS[i], "expr": e[0], "legendFormat": e[1]} for i, e in enumerate(exprs)]
    return {"id": nid(), "type": "timeseries", "title": title, "datasource": PROM,
            "description": desc, "fieldConfig": {"defaults": {"unit": unit, "min": 0,
            "custom": {"fillOpacity": 8, "lineWidth": 2}}}, "targets": tg, "tags": [MARK]}

def sql_stat(title, sql, unit="short", desc="", color="value"):
    return {"id": nid(), "type": "stat", "title": title, "datasource": PG, "description": desc,
            "fieldConfig": {"defaults": {"unit": unit}},
            "options": {"reduceOptions": {"calcs": ["lastNotNull"]}, "colorMode": color, "graphMode": "none"},
            "targets": [{"refId": "A", "format": "table", "rawSql": sql}], "tags": [MARK]}

def sql_table(title, sql, desc=""):
    return {"id": nid(), "type": "table", "title": title, "datasource": PG, "description": desc,
            "fieldConfig": {"defaults": {}}, "targets": [{"refId": "A", "format": "table", "rawSql": sql}], "tags": [MARK]}

def cw_logs(title, expr, h=9):
    return {"id": nid(), "type": "logs", "title": title, "datasource": CW,
            "options": {"showTime": True, "sortOrder": "Descending", "wrapLogMessage": True, "dedupStrategy": "none"},
            "targets": [{"refId": "A", "queryMode": "Logs", "region": REGION,
                         "logGroups": [{"name": f"/aws/rds/instance/{VAR}/postgresql",
                                        "arn": f"arn:aws:logs:{REGION}:771826808455:log-group:/aws/rds/instance/{VAR}/postgresql:*"}],
                         "expression": expr}], "tags": [MARK], "_h": h}

def row(title):
    return {"id": nid(), "type": "row", "title": title, "collapsed": False, "tags": [MARK], "panels": []}

# ── layout: place builders sequentially, 2 wide (w=12) unless _w set ─────────
y = max([p.get("gridPos", {}).get("y", 0) + p.get("gridPos", {}).get("h", 0) for p in d["panels"]] + [0])
def place(items):
    global y
    x = 0
    for it in items:
        if it["type"] == "row":
            if x: y += 8; x = 0
            it["gridPos"] = {"h": 1, "w": 24, "x": 0, "y": y}; y += 1; x = 0
            d["panels"].append(it); continue
        w = it.pop("_w", 12); h = it.pop("_h", 8)
        if x + w > 24: x = 0; y += 8
        it["gridPos"] = {"h": h, "w": w, "x": x, "y": y}
        d["panels"].append(it); x += w
    if x: y += 8

place([
    row("RDS — compute & burst credits (CloudWatch)"),
    ts_cw("CPU credit balance", ["CPUCreditBalance"], "short",
          desc="Burstable t4g credit reserve. Exhaustion throttles to baseline and refuses connections — the failure that forced t4g.micro→small.",
          thresholds=[{"color": "red", "value": 0}, {"color": "orange", "value": 30}, {"color": "green", "value": 60}]),
    ts_cw("CPU credit usage", ["CPUCreditUsage"], "short"),
    ts_cw("Swap usage", ["SwapUsage"], "bytes", desc="Non-zero swap on a 2 GB box signals memory pressure."),
    ts_cw("Burst / EBS IO balance", ["BurstBalance", "EBSIOBalance%", "EBSByteBalance%"], "percent",
          desc="gp2 volume + instance IO burst reserves."),

    row("RDS — throughput & network (CloudWatch)"),
    ts_cw("Network throughput (in / out)", ["NetworkReceiveThroughput", "NetworkTransmitThroughput"], "Bps",
          desc="Bytes over the RDS ENI — the data trafficking to/from the DB."),
    ts_cw("Disk throughput (read / write)", ["ReadThroughput", "WriteThroughput"], "Bps"),
    ts_cw("Disk queue depth", ["DiskQueueDepth"], "short",
          desc="Outstanding IO. Sustained >5 = storage-bound.",
          thresholds=[{"color": "green", "value": 0}, {"color": "orange", "value": 5}]),
    ts_cw("Transaction log generation", ["TransactionLogsGeneration"], "Bps", desc="WAL bytes/s — write pressure proxy."),

    row("RDS — DB load (Performance Insights)"),
    ts_cw("DB load — average active sessions", ["DBLoad", "DBLoadCPU", "DBLoadNonCPU"], "short",
          desc="Average active sessions. Above vCPU count (2) = saturation. Drill into wait events / top SQL in the Performance Insights console."),
    ts_cw("Max used transaction IDs", ["MaximumUsedTransactionIDs"], "short",
          desc="Wraparound risk — autovacuum health. Alert well before ~2 billion.",
          thresholds=[{"color": "green", "value": 0}, {"color": "orange", "value": 1000000000}, {"color": "red", "value": 1500000000}]),

    row("Postgres engine health (live SQL)"),
    sql_stat("Connections used / max",
             "SELECT (SELECT count(*) FROM pg_stat_activity) || ' / ' || current_setting('max_connections') AS used_max", "string",
             desc="Backends vs the server ceiling."),
    sql_stat("Cache hit ratio",
             "SELECT round(100.0*sum(blks_hit)/nullif(sum(blks_hit+blks_read),0),2) AS hit FROM pg_stat_database", "percent",
             desc="Buffer cache effectiveness; <95% suggests memory pressure or cold cache."),
    sql_stat("Deadlocks (cumulative)",
             "SELECT sum(deadlocks)::bigint AS deadlocks FROM pg_stat_database", "short"),
    sql_stat("Blocked backends",
             "SELECT count(*) AS blocked FROM pg_stat_activity WHERE wait_event_type='Lock'", "short"),
    sql_table("Connections by state / application",
              "SELECT state, coalesce(application_name,'-') AS app, count(*) AS conns, "
              "max(now()-xact_start)::text AS longest_txn FROM pg_stat_activity "
              "WHERE backend_type='client backend' GROUP BY state, application_name ORDER BY conns DESC"),
    sql_table("Top tables by dead tuples (autovacuum pressure)",
              "SELECT relname AS table, n_live_tup AS live, n_dead_tup AS dead, "
              "coalesce(last_autovacuum::text,'never') AS last_autovacuum "
              "FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 15"),

    row("PgBouncer — traffic & wait (Prometheus)"),
    ts_prom("Bytes through pooler (in / out)",
            [("sum(rate(pgbouncer_stats_totals_received_bytes_total[5m]))", "received"),
             ("sum(rate(pgbouncer_stats_totals_sent_bytes_total[5m]))", "sent")], "Bps",
            desc="Traffic across the PgBouncer hop."),
    ts_prom("Client max wait (queueing)",
            [("max(pgbouncer_pools_client_maxwait_seconds)", "max wait")], "s",
            desc="Longest a client waited for a server connection — >0 sustained means the pool is saturated."),
    ts_prom("Pooled query & transaction rate",
            [("sum(rate(pgbouncer_stats_totals_queries_pooled_total[5m]))", "queries/s"),
             ("sum(rate(pgbouncer_stats_totals_sql_transactions_pooled_total[5m]))", "txns/s")], "short"),
    ts_prom("Server pool utilisation",
            [("sum(pgbouncer_pools_server_active_connections)", "active"),
             ("sum(pgbouncer_databases_max_connections)", "limit")], "short"),

    row("Connection failures"),
    ts_cw("IAM auth connection failures", ["IamDbAuthConnectionFailure", "IamDbAuthConnectionSuccess"], "short", stat="Sum",
          desc="IAM-token auth outcomes."),
    cw_logs("Connection failures (too-many / auth / pg_hba)",
            "fields @timestamp, @message | filter @message like /too many clients|remaining connection slots|password authentication failed|no pg_hba.conf entry|FATAL/ "
            "| sort @timestamp desc | limit 200"),
])

DASH.write_text(json.dumps(d, indent=1) + "\n")
gen = [p for p in d["panels"] if MARK in (p.get("tags") or [])]
print(f"OK — total panels: {len(d['panels'])}, generated: {len(gen)} (rows+panels), max id {_id[0]}")
json.loads(DASH.read_text())  # validate
print("JSON valid.")
