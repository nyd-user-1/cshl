// Scale a Neon project's read-write compute up or down from the command line.
//
// Nobody in leuk or 44b ever scripted this — every bulk load meant a browser
// tab and a hand-edit in the Neon console, and the scale-down after was the
// step that got forgotten. Two commands replace that:
//
//   node --env-file=.env.local scripts/neon-scale.mjs --min 2 --max 4   # before a load
//   node --env-file=.env.local scripts/neon-scale.mjs --min 0.25 --max 4  # after
//   node --env-file=.env.local scripts/neon-scale.mjs                   # show current
//
// Needs NEON_API_KEY_2525 (org-scoped) and NEON_PROJECT_ID in the env.
// NOTE: any autoscale-config change RESTARTS the compute and zeroes pg_stat
// counters — take progress baselines AFTER scaling, never before.

const API = "https://console.neon.tech/api/v2";
const key = process.env.NEON_API_KEY_2525;
const project = process.env.NEON_PROJECT_ID;
if (!key || !project) {
  console.error("NEON_API_KEY_2525 and NEON_PROJECT_ID must be set");
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]),
);
// support both "--min 2" and "--min=2"
for (let i = 2; i < process.argv.length - 1; i++) {
  const a = process.argv[i];
  if (a.startsWith("--") && !a.includes("=") && !process.argv[i + 1].startsWith("--")) {
    args[a.slice(2)] = process.argv[i + 1];
  }
}

const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers, body: body && JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

const { endpoints } = await api("GET", `/projects/${project}/endpoints`);
const rw = endpoints.find((e) => e.type === "read_write");
if (!rw) throw new Error("no read_write endpoint found");

console.log(
  `current: ${rw.id} min=${rw.autoscaling_limit_min_cu} max=${rw.autoscaling_limit_max_cu} state=${rw.current_state}`,
);

if (args.min || args.max) {
  const endpoint = {};
  if (args.min) endpoint.autoscaling_limit_min_cu = Number(args.min);
  if (args.max) endpoint.autoscaling_limit_max_cu = Number(args.max);
  const updated = await api("PATCH", `/projects/${project}/endpoints/${rw.id}`, { endpoint });
  console.log(
    `updated: min=${updated.endpoint.autoscaling_limit_min_cu} max=${updated.endpoint.autoscaling_limit_max_cu}`,
  );
  console.log("compute restarts on config change — pg_stat counters are now zeroed");
}
