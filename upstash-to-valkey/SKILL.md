---
name: upstash-to-valkey
description: Move a Redis off Upstash (including a store created through the Vercel Marketplace) to Valkey you run yourself, without changing application code, or decide not to. Options compared with October 2026 prices (Upstash free and pay-as-you-go, Upstash through AWS Marketplace, ElastiCache, one EC2 instance, ECS Fargate with EFS); measured latency and failover benchmarks; the serverless-redis-http front that keeps @upstash/redis working and the two fixes it needs; an ECS task design tuned from a 108 s to a 74 s failover; a backup-restore-reconcile procedure over REST that fences the old store so late writes are not lost; a failover test; and the pitfalls hit on a real production move. Use when retiring a Vercel team that owns an Upstash store, choosing where a small Redis should live, self-hosting an Upstash-compatible endpoint, or testing and tuning its failover.
---

# Upstash to Valkey

`@upstash/redis` talks HTTPS to a REST endpoint, not the Redis protocol, so a
replacement has to speak Upstash's REST protocol.
[serverless-redis-http](https://github.com/hiett/serverless-redis-http) (SRH)
does: put it in front of Valkey and the application keeps its code, changing
only the URL and token it reads (`KV_REST_API_URL` / `KV_REST_API_TOKEN`, or
`UPSTASH_REDIS_REST_*`). Everything below was measured on a real production
move in October 2026. A complete worked example (Terraform for ECS Fargate,
the SRH patch, backup, restore, reconcile and failover-test scripts, and the
end-to-end probe) is public at
[ejc3/upstash-to-ecs-valkey](https://github.com/ejc3/upstash-to-ecs-valkey).

## 1. Decide whether to move at all

Ask what forces the move before choosing a destination:

- **A Vercel Marketplace store dies with its team.** It is billed and owned
  through the Vercel team, cannot be transferred to another team (the transfer
  feature covers other integrations, not Upstash), and deleting the team
  deletes it. Retiring the team means moving the data first, but not
  necessarily off Upstash: a new Upstash database in an account you own is
  the smallest move.
- **Requests over 10 MB.** Upstash's request limit is 10 MB on Free,
  pay-as-you-go and the small fixed plans; larger requests start at 20 MB on
  the $100/month Fixed 5 GB plan (50 MB is $400/month). A hash or JSON value
  written in one command above the limit fails.
- **Data in your own cloud account**, or a cluster you want for other services
  anyway.

Prices for one measured workload: about 1 million commands a month (mostly a
one-minute cron), 20 MB of data, 16 GB a month of responses, AWS us-west-1.
Check your region and the current price pages before quoting.

| Option | Monthly | Failover | Reachable from Workers, Vercel, CI | Upkeep |
|---|---|---|---|---|
| Upstash free | $0, but capped at 500k commands a month | managed | yes | none |
| Upstash pay-as-you-go | **~$2** ($0.20 per 100k commands) | managed, replicated | yes | none |
| Upstash through AWS Marketplace | same usage, on the AWS invoice | managed | yes | none |
| ElastiCache (Valkey), one node | ~$12 (cache.t4g.micro), **plus** a proxy | none automatic: a single node has no replica to fail over to | no: VPC only, so SRH and a tunnel are needed anyway | the proxy |
| ElastiCache (Valkey), Multi-AZ | ~$24 (primary and a replica in another zone), **plus** a proxy | managed automatic failover | same | the proxy |
| One EC2 instance (t4g.micro, Docker) | ~$11 | none: down until someone restarts it | through a tunnel | OS, images, patches |
| ECS Fargate + EFS | ~$21-25 (0.5 vCPU / 1 GB ARM task ~$16.60, public IPv4 $3.65, EFS cents, logs) | task replaced automatically, any zone; **74 s** measured for a stopped task | through a tunnel | images only |

**Default recommendation:** Upstash pay-as-you-go in an account you own, in
your callers' region. It is cheaper, managed and replicated. Self-host only
for one of the reasons above, and say plainly what it costs: one copy of the
data (up to about a second of writes lost if the process dies abruptly, see
section 3), a gap of a minute or more on a failure or deploy (74 s measured
for a stopped task), and images to keep current.

## 2. Benchmarks to quote (and how they were taken)

Latency, from an EC2 instance in us-west-1, `PING` plus `GET` of a 260 KB key,
20 runs:

| Endpoint | p50 | p90 |
|---|---|---|
| Valkey in us-west-1 behind SRH and a Cloudflare Tunnel | **59 ms** | 78 ms |
| The Marketplace Upstash store (region picked by the integration) | 194 ms | 258 ms |

That gap is mostly region, not product: an Upstash database in the callers'
region closes most of it. Do not present it as an Upstash benchmark.

Failover of a single-task ECS service, measured from `ecs stop-task` (a
graceful stop: SIGTERM, then the replacement) to the public endpoint answering,
polling every 2 s (method in section 6). An abrupt failure (the host or the
process dying) follows the same replacement path but was not timed; measure it
before quoting a number for it.

| Task design | Outage |
|---|---|
| `dependsOn` chain gated on `HEALTHY`, checks every 15 s, 30 s start periods | 108 s |
| same chain, checks every 5 s | 84 s |
| + 2 s `stopTimeout` on the stateless containers | 89 s: no change |
| no `dependsOn`, checks every 5 s | **74 s** |

Where the 74 s went: the old task's containers stopped in 2 s; Fargate took
~38 s to tear the old task down before placing the replacement; the new task
took ~36 s (network interface, image pull, EFS mount, start). No task setting
moved those two Fargate phases, and they vary from run to run, so treat ~75 s
as what one task achieved here, not a guarantee. Lower needs a hot standby with
its own storage and a promotion step: that is what the managed options sell.

## 3. The self-hosted shape

One task (or one host) with four processes and no inbound port:

- **valkey**, append-only file with `appendfsync everysec`, on storage that
  survives the host (EFS on Fargate, replicated across zones; back it up).
- **srh** per environment, each on its own loopback port, database number and
  token (`SRH_MODE=env`, `SRH_TOKEN`, `SRH_CONNECTION_STRING=redis://127.0.0.1:6379/<db>`,
  `SRH_PORT`).
- **cloudflared**, dialling out, publishing one hostname per environment to
  `http://127.0.0.1:<port>`. The REST token is the credential, exactly as with
  Upstash; check that a wrong token gets 401.
- **Exactly one copy, ever.** Two Valkeys on one append-only file corrupt it,
  and two connectors on one tunnel split writes between two stores. On ECS:
  `desired_count = 1`, `deployment_minimum_healthy_percent = 0`,
  `deployment_maximum_percent = 100`.

Build SRH with the two fixes in section 5 and serve every image from a private
registry, not Docker Hub at task start.

**Task definition settings that matter for failover (ECS):**

- **No `dependsOn` between the containers.** Fargate stops dependent containers
  one after another in reverse order at about 12 s per step even when each
  exits within a second of SIGTERM, and the replacement waits for the last one.
  The order is not needed: SRH starts without Valkey, answers
  `SRH: Unable to connect to the Redis server` until it is up, serves within a
  second of it, and recovers by itself after a Valkey restart; cloudflared
  answers 502 until SRH listens.
- **Health checks every 5 s** (the ECS minimum) on every container, so ECS
  replaces a task whose process hangs. Keep start periods generous (60 s for
  Valkey loading its file, 30 s for SRH): a start period only forgives early
  failures and the first success ends it, so shortening it never makes anything
  faster.
- **`stopTimeout` 60 s for Valkey**: on SIGTERM it flushes the append-only
  file and writes a snapshot before exiting, so a graceful stop loses nothing
  acknowledged; give it time on network storage. 2 s for the stateless
  containers.
- **Know the durability window.** With `appendfsync everysec`, an abrupt
  failure (the host or the process dying, no SIGTERM) can lose about the last
  second of acknowledged writes, and there is one copy. If that is not
  acceptable, use `appendfsync always` (slower writes) or a replicated or
  managed store.

## 4. Move the data without losing late writes

1. **Count the key types** with `SCAN` plus `TYPE`, and have an exporter for
   every type present before calling a backup complete. Upstash serves `DUMP`
   over REST, but Valkey 8.1 rejected its payload on `RESTORE` (`ERR DUMP
   payload version or checksum are wrong`, tested on a key from a real store),
   so unless you have restored one key into your target first, export by type:
   `GET`, `HGETALL`, `SMEMBERS`,
   `LRANGE 0 -1`, `ZRANGE 0 -1 WITHSCORES`, `XRANGE - +`, plus `PTTL`, with
   `Upstash-Encoding: base64` so binary values survive. Write backups with
   mode 0600. **Streams with consumer groups** need more than `XRANGE`:
   record each group's name and last-delivered ID (`XINFO GROUPS <key>`) and
   recreate it on the target at that ID after the entries are restored
   (`XGROUP CREATE <key> <group> <id>`), or consumers fail with `NOGROUP` or
   skip and replay messages. Pending entries (delivered, not acknowledged)
   cannot be carried over by REST: pause the consumers and let them process or
   claim what is pending before the final export. Never `XACK` entries just to
   empty the list; that drops work nobody finished.
2. **Bring the new store up empty and probed** (on ECS, everything created with
   the task count at zero, then started).
3. **Final export** from the old store, from the credential that still points
   at it, after pausing scheduled writers where you can.
4. **Restore before any consumer gets the new credentials.** A cron that starts
   on an empty store sees no subscribers and no "already sent" records and acts
   on that. Reduce each key's TTL by the time since it was captured and skip
   keys that expired meanwhile. Verify the count and every key's type.
5. **Switch consumers** (application secrets, CI secrets, functions), right
   after the restore.
6. **Fence the old store, then reconcile once.** Writers keep reaching the old
   store after the final export (in-flight jobs, clients holding old
   credentials, the old platform serving cached clients until its DNS
   expires), and a diff taken while they still can write misses whatever
   lands after it. So first stop all writes to the old store: rotate or revoke
   its credentials (or pause every writer) once the consumers have switched.
   Then export it one last time and diff three ways against the final export
   and the new store: a key changed only in the old store is copied, one
   deleted only there is deleted, one changed on both sides is decided by
   hand. Compare hashes field by field: `HGETALL` order is not stable. On the
   measured move: 12 keys changed after the export; 2 were copied, 10 were
   already newer in the new store.
7. **Keep the old store, read-only,** until that diff is applied and a day of
   traffic is clean; only then delete it.

## 5. Pitfalls, each hit for real

- **SRH refuses requests over 8 MB with an empty 500.** It hard-codes Plug's
  default body limit; `@upstash/redis` reports
  `UpstashJSONParseError: Unable to parse response body`. Raise the limit
  (64 MB worked).
- **SRH parses the body before checking the token**, so raising the limit alone
  lets an anonymous caller make it decode 64 MB per request. Add a plug that
  compares the bearer token in constant time before `Plug.Parsers`, so an
  unauthenticated request gets 401 unread.
- **Two SRH containers in one awsvpc task collide.** Every container shares one
  hostname and both Elixir releases default to node name `prod@<host>`: the
  second exits ("the name prod@... seems to be in use by another Erlang node")
  and takes the task down. Set `RELEASE_NODE` per container.
- **Building SRH on a 1 GB machine is OOM-killed.** Build it in CI or a build
  service (an ARM CodeBuild project works).
- **Cloudflare blocks Python's default user agent** (403, Browser Integrity
  Check, error 1010). Every script that calls the endpoint sets its own.
- **`kill 1` inside a container is not a crash test**: signals sent to PID 1
  from inside its namespace are ignored unless the process handles them. Stop
  the task, or `valkey-cli SHUTDOWN NOSAVE`.
- **ECS Exec from a script blocks** until the interactive session ends; time a
  process-exit test from the endpoint, not from the exec call.
- **A Workers Free plan CPU limit** looks like a Redis problem (intermittent
  Error 1102 on pages that read the store). Check the plan first.

## 6. Test failover before calling it done

Write a canary key, record the keys that have no expiry, break something, and
poll the public endpoint every 2 s through the same hostname the application
uses. When it answers again, check the canary and that no key without an
expiry went missing. Run it once per change, with `python3 -u` so the timeline
prints as it happens:

- `ecs stop-task` (what a host failure or a deploy looks like),
- the store process exiting (`valkey-cli SHUTDOWN NOSAVE` via ECS Exec),
- the alert path: the probe's alarm fires when the endpoint stays down for its
  evaluation window, and reaches someone who confirmed the subscription.

Then read the replacement task's timestamps (`createdAt`, `pullStartedAt`,
`pullStoppedAt`, `startedAt`) and the old task's (`stoppingAt`, `stoppedAt`)
next to the containers' log lines (SIGTERM received, ready to accept
connections, tunnel registered): that breakdown is what tells you whether a
setting can still help or the rest is the platform.

## References

- Worked example: https://github.com/ejc3/upstash-to-ecs-valkey
- serverless-redis-http: https://github.com/hiett/serverless-redis-http
- Upstash pricing and limits: https://upstash.com/pricing
- ECS container dependencies and stop order: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html
- Fargate pricing: https://aws.amazon.com/fargate/pricing/
