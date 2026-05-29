#!/usr/bin/env bash
# End-to-end smoke test for the qdrn-radar server. Spins up the server against
# mock aircraft + gateway feeds and asserts the major behaviors. Run with:
#   ./scripts/verify.sh
# Exits non-zero on any failure.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

[ -f apps/server/dist/index.js ] || npm run build --workspace @qdrn/server >/dev/null

PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf "  \033[32m✓\033[0m %s\n" "$1"; }
ng(){ FAIL=$((FAIL+1)); printf "  \033[31m✗\033[0m %s — %s\n" "$1" "$2"; }
wait_ready(){ for _ in $(seq 1 50); do curl -sf "http://localhost:$1/md/healthz" >/dev/null && return 0; sleep 0.1; done; return 1; }

# Mocks (written fresh each run so the script is self-contained).
cat > /tmp/qdrn-verify-feed.mjs <<'JS'
import http from "node:http";
let t=0;
http.createServer((_,r)=>{
  t++;
  const list=[{hex:"persist1",flight:"DAL2864",lat:45.05,lon:-93.0,alt_baro:34000,gs:450,track:90,seen:0,rssi:-22}];
  if(t<=2)list.push({hex:"gone0001",flight:"GONE",lat:44.5,lon:-92.4,alt_baro:25000,gs:400,track:120,seen:0,rssi:-25});
  if(t>2)list.push({hex:"far0001",flight:"FAR1",lat:46.5,lon:-90.5,alt_baro:38000,gs:480,track:90,seen:0,rssi:-30});
  r.setHeader("content-type","application/json");
  r.end(JSON.stringify({now:Date.now()/1000,messages:1,aircraft:list}));
}).listen(9001);
JS
cat > /tmp/qdrn-verify-gw.mjs <<'JS'
import http from "node:http";
const MODE=process.env.MODE||"ok"; // ok | blocked | badkey
http.createServer((req,res)=>{
  const auth=req.headers.authorization||"";
  res.setHeader("content-type","application/json");
  if(MODE==="badkey"||auth!=="Bearer devkey"){res.statusCode=401;return res.end('{"e":"bad"}');}
  if(req.url.startsWith("/v1/status")){
    if(MODE==="blocked"){res.statusCode=429;return res.end("{}");}
    return res.end(JSON.stringify({key:{name:"Test",used:42,limit:1000,resets:null}}));
  }
  if(req.url.startsWith("/v1/route/")){
    if(MODE==="blocked"){res.statusCode=429;return res.end("{}");}
    return res.end(JSON.stringify({origin:{iata:"EWR",icao:"KEWR"},destination:{iata:"MSP",icao:"KMSP"},airline:{iata:"DL",name:"Delta"}}));
  }
  res.statusCode=404;res.end("{}");
}).listen(9002);
JS

start_server(){ # $1=gateway mode, $2=port
  rm -f /tmp/qdrn-verify.db
  MODE=$1 node /tmp/qdrn-verify-gw.mjs >/tmp/qdrn-verify-gw.log 2>&1 & GW=$!
  node /tmp/qdrn-verify-feed.mjs >/tmp/qdrn-verify-feed.log 2>&1 & FD=$!
  DB_PATH=/tmp/qdrn-verify.db PORT=$2 BASE_PATH=/md SETUP_PIN=1234 POLL_INTERVAL_MS=500 STALE_DROP_MS=2000 \
    GATEWAY_URL=http://localhost:9002 GATEWAY_KEY=devkey \
    AIRCRAFT_JSON_URL=http://localhost:9001/ node apps/server/dist/index.js >/tmp/qdrn-verify-srv.log 2>&1 & SV=$!
  wait_ready "$2" || { echo "server didn't come up; tail /tmp/qdrn-verify-srv.log"; tail /tmp/qdrn-verify-srv.log; exit 1; }
}
stop_server(){ kill "$SV" "$GW" "$FD" 2>/dev/null; sleep 0.3; }
api(){ curl -s -m 5 "http://localhost:$PORT/md/api$1"; }
papi(){ curl -s -m 5 -X POST -H 'content-type: application/json' -d "$2" "http://localhost:$PORT/md/api$1"; }

PORT=9100
echo "── 1. Config / greeting / ARTCC / pilot ───────────────────────"
start_server ok "$PORT"
[ "$(api /config | python3 -c 'import sys,json;c=json.load(sys.stdin);print(c["receiver"]["artcc"]["id"])')" = "ZMP" ] \
  && ok "Minneapolis -> ARTCC ZMP" || ng "ARTCC" "expected ZMP"
papi /setup/name '{"pin":"1234","name":"Collin"}' >/dev/null
[ "$(api /config | python3 -c 'import sys,json;print(json.load(sys.stdin)["pilotName"])')" = "Collin" ] \
  && ok "pilotName persists in /config" || ng "pilotName" "not Collin"

echo "── 2. PIN auth ────────────────────────────────────────────────"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"pin":"0000"}' "http://localhost:$PORT/md/api/setup/settings")" = "401" ] \
  && ok "bad PIN -> 401" || ng "bad PIN" "should be 401"
papi /setup/settings '{"pin":"1234"}' | python3 -c "import sys,json;d=json.load(sys.stdin);assert 'gateway' in d and 'aero' in d" \
  && ok "good PIN returns AdminSettings (incl. gateway)" || ng "settings shape" ""

echo "── 3. Coverage grows + persists ───────────────────────────────"
sleep 2.5
N1=$(api /coverage | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
[ "$N1" -ge 2 ] && ok "coverage has multiple buckets ($N1)" || ng "coverage growth" "only $N1"
stop_server
DB_PATH=/tmp/qdrn-verify.db PORT=9101 BASE_PATH=/md AIRCRAFT_JSON_URL=http://localhost:9 node apps/server/dist/index.js >/tmp/qdrn-verify-srv2.log 2>&1 & SV=$!
wait_ready 9101 >/dev/null
N2=$(curl -s http://localhost:9101/md/api/coverage | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
[ "$N2" = "$N1" ] && ok "coverage persists across restart ($N2)" || ng "coverage persistence" "got $N2 want $N1"
kill "$SV" 2>/dev/null; sleep 0.3

echo "── 4. Stale-drop ──────────────────────────────────────────────"
PORT=9100; start_server ok "$PORT"
sleep 1
A=$(api /aircraft | python3 -c 'import sys,json;print(any(a["hex"]=="gone0001" for a in json.load(sys.stdin)["aircraft"]))')
sleep 3
B=$(api /aircraft | python3 -c 'import sys,json;print(any(a["hex"]=="gone0001" for a in json.load(sys.stdin)["aircraft"]))')
[ "$A" = "True" ] && [ "$B" = "False" ] && ok "stale aircraft drops after STALE_DROP_MS" || ng "stale-drop" "was=$A now=$B"

echo "── 5. Gateway route + status (ok) ─────────────────────────────"
R=$(api /aircraft/persist1 | python3 -c 'import sys,json;r=(json.load(sys.stdin)["enrichment"] or {}).get("route") or {};print(r.get("source"),"|",(r.get("origin") or {}).get("iata"),"->",(r.get("destination") or {}).get("iata"))')
[ "$R" = "gateway | EWR -> MSP" ] && ok "click flight -> gateway route ($R)" || ng "gateway route" "got [$R]"
papi /setup/connections '{"pin":"1234","force":true}' | python3 -c "
import sys,json;d=json.load(sys.stdin)
assert d['gateway']=='ok', d['gateway']
i=d['gatewayInfo']; assert i['used']==42 and i['limit']==1000, i
" && ok "gateway 'ok' + quota" || ng "ok status" ""
stop_server

echo "── 6. Gateway 'blocked' (over limit) ──────────────────────────"
start_server blocked "$PORT"
S=$(papi /setup/connections '{"pin":"1234","force":true}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["gateway"])')
[ "$S" = "blocked" ] && ok "429 -> 'blocked'" || ng "blocked status" "got $S"
api /aircraft/persist1 >/dev/null && ok "blocked gateway -> graceful fallback (no crash)" || ng "blocked fallback" ""
stop_server

echo "── 7. Gateway 'invalid' (bad device key) ──────────────────────"
start_server badkey "$PORT"
S=$(papi /setup/connections '{"pin":"1234","force":true}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["gateway"])')
[ "$S" = "invalid" ] && ok "401 -> 'invalid'" || ng "invalid status" "got $S"
stop_server

echo
printf "── \033[32m%d passed\033[0m, \033[31m%d failed\033[0m ──\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
