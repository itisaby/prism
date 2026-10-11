#!/bin/sh
# Pretend to drain a checkout queue: one order every 2-4 s, the odd retry, a heartbeat every ~30 s.
VERSION="${CHECKOUT_VERSION:-v1}"
HOST="$(hostname)"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) level=$1 worker=$HOST version=$VERSION $2"; }
log info "msg=\"checkout worker started\" queue=orders.checkout redis=redis.shop.svc:6379"
n=0
while true; do
  n=$((n + 1))
  r=$(awk -v s="$n$$" 'BEGIN{srand(s); printf "%d %d %d %d", rand()*90000+10000, rand()*400+20, rand()*100, rand()*3+1}')
  set -- $r
  order="ord_$1"; ms=$2; roll=$3; items=$4
  cents=$(( ($1 % 17000) + 999 ))
  amount="$((cents / 100)).$(printf '%02d' $((cents % 100)))"
  if [ "$roll" -lt 4 ]; then
    log warn "msg=\"payment provider slow, retrying\" order=$order attempt=2 latency_ms=$((ms * 4))"
  fi
  log info "msg=\"order processed\" order=$order items=$items amount_usd=$amount latency_ms=$ms"
  if [ $((n % 12)) -eq 0 ]; then
    log info "msg=heartbeat processed_total=$n queue_depth=$((roll % 7))"
  fi
  sleep $(( (roll % 3) + 2 ))
done
