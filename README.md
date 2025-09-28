# cfworker-vless.js project

  Vless proxy implementation based on Cloudflare Worker.

  > Support NAT64 to bypass Cloudflare CDN network restrictions.

  The code of worker.js is highly compact and can be
  used to edit and deploy Cloudflare Workers on mobile
  devices (Android/WebView, etc.).

### NAT64

  |NAT64 prefix     |Provider|      Country / City     |
  |-----------------|--------|-------------------------|
  |2602:fc59:b0:64::|ZTVI    |        U.S.A / Fremont  |
  |2602:fc59:11:64::|ZTVI    |        U.S.A / Chicago  |
  |2a02:898:146:64::|Coloclue|  Netherlands / Amsterdam|

### Variable

  |Variable     |Description                    |
  |-------------|-------------------------------|
  |opt\_uuid    |Vless user id                  |
  |opt\_dohurl  |Used for udp:53 dns query (doh)|
  |opt\_prefix64|NAT64 proxy prefix ip          |

  > opt\_prefix64 < env.opt\_prefix64 < url param opt\_prefix64

  ws\_path config prefix64: /?ed=2048&opt\_prefix64=2602:fc59:11:64::

## Tools

  - misc
    - clash-proxy-yaml.sh -- generate the Clash proxy YAML config for cfworker-vless.js

## Reference

  - [EDtunne of 3Kmfi6HP](https://github.com/3Kmfi6HP/EDtunne)
    - ref\_worker.js

## licenses

  - GPL-3.0
