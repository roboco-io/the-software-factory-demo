#!/bin/sh
# Runs inside the container. $1 = run id (harmless random marker), $2 = logging domain.
# Each probe uses its own label, so a hit in the DNS log names the probe that leaked.
R=$1; D=$2
sec() { echo; echo "=== $1"; }
sec env; cat /etc/resolv.conf; echo; grep hosts /etc/nsswitch.conf; ip -br addr; ip route; ip -6 route
sec "p01 getent ahosts (libc, default resolver)"; timeout 10 getent ahosts "p01-$R.$D"; echo "rc=$?"
sec "p02 dig A default resolver"; timeout 15 dig +time=3 +tries=1 "p02-$R.$D" A
sec "p03 dig TXT default resolver"; timeout 15 dig +time=3 +tries=1 "p03-$R.$D" TXT
sec "p04 dig A +tcp default resolver"; timeout 15 dig +tcp +time=3 +tries=1 "p04-$R.$D" A
NS=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)
sec "p05 dig AAAA @$NS"; timeout 15 dig +time=3 +tries=1 @"$NS" "p05-$R.$D" AAAA
sec "p06 non-existent TLD"; timeout 10 getent ahosts "p06-$R.invalid-tld-zz"; echo "rc=$?"
sec "p07 real-answer names (would show a resolver IP if forwarded)"
timeout 15 dig +time=3 +tries=1 TXT o-o.myaddr.l.google.com +short; timeout 15 dig +time=3 +tries=1 CH TXT whoami.cloudflare +short
sec "p08 direct UDP 53 @1.1.1.1 / @8.8.8.8"; timeout 15 dig +time=3 +tries=1 @1.1.1.1 "p08a-$R.$D"; timeout 15 dig +time=3 +tries=1 @8.8.8.8 "p08b-$R.$D"
sec "p09 direct TCP 53 @1.1.1.1"; timeout 15 dig +tcp +time=3 +tries=1 @1.1.1.1 "p09-$R.$D"
sec "p10 DoT 853 @1.1.1.1"; timeout 15 dig +tls +time=3 +tries=1 @1.1.1.1 "p10-$R.$D"
sec "p11 DoH dig +https @1.1.1.1"; timeout 15 dig +https +time=3 +tries=1 @1.1.1.1 "p11-$R.$D"
sec "p12 DoH curl cloudflare-dns.com"; timeout 15 curl -sS -m 10 -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=p12-$R.$D&type=A"; echo " rc=$?"
sec "p13 DoH curl dns.google"; timeout 15 curl -sS -m 10 "https://dns.google/resolve?name=p13-$R.$D&type=A"; echo " rc=$?"
sec "p14 HTTPS to marker host (does interception resolve the name?)"; timeout 15 curl -sS -m 10 "https://p14-$R.$D/"; echo " rc=$?"
sec "p15 HTTP to marker host"; timeout 15 curl -sS -m 10 "http://p15-$R.$D/"; echo " rc=$?"
sec "p16 python socket.getaddrinfo"; timeout 10 python3 -c "import socket;print(socket.getaddrinfo('p16-$R.$D',443))"; echo "rc=$?"
sec "p17 raw UDP 53 to resolver IPs from resolv.conf via nc"; printf 'x' | timeout 5 nc -u -w2 "$NS" 53; echo "rc=$?"
sec "p18 other record types via default resolver"
for t in MX CNAME NS SRV HTTPS ANY; do echo "-- $t"; timeout 8 dig +time=3 +tries=1 +short "p18$(echo $t | tr A-Z a-z)-$R.$D" $t; done
sec "p19 long label (data-shaped) A query"; timeout 8 dig +time=3 +tries=1 +short "6d61726b65722d6e6f742d612d736563726574-p19-$R.$D" A
sec done
