import { connect } from "cloudflare:sockets";

const opt_uuid = "98f475f4-bd96-49f6-98af-9e16103b5ec2";
const opt_dohurl = "https://dns.google/dns-query";
const opt_prefix64 = "2602:fc59:b0:64::";
const opt_proxyip = "";

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

function get_proxyip(obj) {
  return obj.proxyip_config_ip || obj.proxyip;
}

async function _get_domain_to_ipv4(domain) {
  try { const resp = await fetch(`https://1.1.1.1/dns-query?name=${domain}&type=A`,
      { headers: { "Accept": "application/dns-json" } });
    const result = await resp.json();
    if (result.Answer && result.Answer.length > 0) { const a = result.Answer.find(
        record => record.type === 1); if (a) return a.data; }
  } catch (error) { console.log("proxyip domain query error", domain, error); }
  return null;
}

async function set_proxyip_config(obj, address, address_type, port) {
  obj.proxyip_config_ip = null; if (!obj.prefix64) return;
  switch (address_type) {
    case 2: address = await _get_domain_to_ipv4(address);
      if (!address) break;
    case 1: const s = new Uint8Array(address.split('.'));
      const a = Array.from(s).map(byte => byte.toString(16).padStart(2, '0'));
      obj.proxyip_config_ip = `[${obj.prefix64}${a[0]}${a[1]}:${a[2]}${a[3]}]`;
    default:
  }
}

function base64url_to_buf(str) {
  if (str) { try { const decode = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
      const _array = Array.from(decode, (c) => c.charCodeAt(0));
      const array = new Uint8Array(_array).buffer; return { data: array, error: null };
    } catch(error) { return { data: null, error: error }; }
  } return { data: null, error: null };
}

function vls_header(buf, uuid) {
  if (buf.byteLength < 24) { return { error: true, message: "invalid data" }; }
  const version = new Uint8Array(buf.slice(0, 1))[0]; let offset = 1;
  const arruuid = new Uint8Array(buf.slice(offset, offset + 16));
  const struuid = Array.from(arruuid) /* user id */
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const _uuid = Array.from(uuid).filter(char => char !== '-').join('');
  if (struuid !== _uuid) {
    return { error: true, message: `invalid user: ${struuid}` }; } offset += 16;
  const message_len = new Uint8Array(buf.slice(offset, offset + 1))[0];
  offset += 1 + message_len;
  const command = new Uint8Array(buf.slice(offset, offset + 1))[0];
  let is_udp = false; /* 1: tcp, 2: udp, 3: mux */
  switch (command) {
    case 1: is_udp = false; break;
    case 2: is_udp = true; break;
    case 3: return { error: true, message: "invalid command: 3 is not support" };
    default: return { error: true, message: `invalid command: ${command}` };
  } offset += 1;
  const port = new DataView(buf.slice(offset, offset + 2)).getUint16(0); offset += 2;
  const address_type = new Uint8Array(buf.slice(offset, offset + 1))[0];
  offset += 1; let address = null; /* 1: ipv4, 2: domain, 3: ipv6 */
  switch (address_type) {
    case 1: if (buf.byteLength < (offset + 4)) break;
      address = new Uint8Array(buf.slice(offset, offset + 4)).join('.'); offset += 4;
      break;
    case 2: const domain_len = new Uint8Array(buf.slice(offset, offset + 1))[0];
      if (buf.byteLength < (offset + 1 + domain_len)) break;
      address = new TextDecoder().decode(buf.slice(offset + 1, offset + 1 + domain_len));
      offset += 1 + domain_len;
      break;
    case 3: if (buf.byteLength < (offset + 16)) break;
      const ipv6 = new DataView(buf.slice(offset, offset + 16)); address = [];
      for (let i = 0; i < 8; i++) { address.push(ipv6.getUint16(i * 2).toString(16)
        .padStart(4, '0')); } address = '[' + address.join(':') + ']'; offset += 16;
      break;
    default:
  } if (!address) { return { error: true, message: "invalid address" }; }
  return { error: false, address_type: address_type, address: address, port: port,
    offset: offset, version: version, is_udp: is_udp };
}

async function dns_handle(obj, remote_stream, ws, header) {
  const tf_stream = new TransformStream({
      transform(chunk, controller) {
        for (let i = 0; i < chunk.byteLength; ) { const buffer = chunk.slice(i, i + 2);
          const length = new DataView(buffer).getUint16(0);
          const data = new Uint8Array(chunk.slice(i + 2, i + 2 + length));
          i += 2 + length; controller.enqueue(data); }
      }
    });
  let is_header = false; /* remote --> ws */
  tf_stream.readable.pipeTo(new WritableStream({
      async write(chunk) {
        const resp = await fetch(obj.dohurl, { method: "POST",
            headers: { "content-type": "application/dns-message" }, body: chunk });
        const result = await resp.arrayBuffer(); const size = result.byteLength;
        const size_buffer = new Uint8Array([ (size >> 8) & 0xff, size & 0xff ]);
        if (ws.readyState === WS_READY_STATE_OPEN) {
          console.log(`dns message length is ${size}`);
          if (is_header) { ws.send(await new Blob([ size_buffer, result ]).arrayBuffer());
          } else { ws.send(await new Blob([ header, size_buffer, result ]).arrayBuffer());
            is_header = true; }
        } else { console.log("websocket is not open (dns)"); }
      }
    })).catch((error) => { console.log("dns query error", error) });
  remote_stream.writer = tf_stream.writable.getWriter();
}

async function tcp_pipe_handle(remote_socket, ws, header, retry) {
  let is_header = false; /* remote --> ws */
  await remote_socket.readable.pipeTo(new WritableStream({
      async write(chunk, controller) {
        if (ws.readyState !== WS_READY_STATE_OPEN) {
          controller.error("websocket is not open (tcp)"); }
        if (is_header) { ws.send(chunk); } else {
          ws.send(await new Blob([ header, chunk ]).arrayBuffer()); is_header = true; }
      },
      close() { console.log("remote connection readable is close (tcp)"); },
      abort(reason) { console.log("remote connection readable is abort (tcp)", reason); }
    })).catch((error) => { console.log("remote to websocket error (tcp)", error);
      ws_close(ws); });
  if (!is_header && retry) { console.log("retry!"); retry(); }
}

async function tcp_handle(obj, remote_stream, ws, header, remote_address, remote_port, rawdata) {
  if (obj.is_fproxyip) remote_address = get_proxyip(obj) || remote_address;
  const connect_and_write = async (address, port, data) => {
    console.log(`connected to ${address}:${port}`); const tcp_socket = connect(
      { hostname: address, port: port }); remote_stream.writer = tcp_socket;
    const writer = tcp_socket.writable.getWriter(); await writer.write(data);
    writer.releaseLock(); return tcp_socket;
  };
  const retry = async () => { /* proxyip --> self/target (http[s] reverse proxy to self), or */
    remote_address = get_proxyip(obj) || remote_address; /* nat64 --> suffixe/target */
    const tcp_socket = await connect_and_write(remote_address, remote_port, rawdata);
    tcp_socket.closed.catch(error => { console.error("retry tcpsocket closed error", error);
      }).finally(() => { ws_close(ws); });
    tcp_pipe_handle(tcp_socket, ws, header, null);
  };
  const tcp_socket = await connect_and_write(remote_address, remote_port, rawdata);
  tcp_pipe_handle(tcp_socket, ws, header, retry);
}

function ws_close(ws) {
  try { if (ws.readyState === WS_READY_STATE_OPEN || ws.readyState === WS_READY_STATE_CLOSING) {
      ws.close(); } } catch (error) { console.log("websocket close error", error); }
}

function ws_stream(ws, ws_sec) {
  return new ReadableStream({
      start(controller) {
        ws.addEventListener("message", (event) => { controller.enqueue(event.data); });
        ws.addEventListener("close", () => { ws_close(ws); controller.close(); });
        ws.addEventListener("error", (error) => {
          console.log("websocket server error"); controller.error(error); });
        const { data, error } = base64url_to_buf(ws_sec);
        if (error) { controller.error(error); } else if (data) { controller.enqueue(data); }
      },
      cancel(reason) { console.log("readable stream is canceled", reason); ws_close(ws); }
    });
}

async function ws_handle(obj, request) {
  const ws_pair = new WebSocketPair(); const [ client, ws ] = Object.values(ws_pair);
  ws.accept(); /* server */ const ws_sec = request.headers.get("sec-websocket-protocol");
  const ws_pipe = ws_stream(ws, ws_sec);
  let remote_stream = { writer: null }; let is_dns = false;
  ws_pipe.pipeTo(new WritableStream({
      async write(chunk, controller) { /* ws -> remote dns */
        if (is_dns && remote_stream.writer) { return remote_stream.writer.write(chunk); }
        if (remote_stream.writer) { const writer = remote_stream.writer.writable.getWriter();
          await writer.write(chunk); writer.releaseLock(); return; /* ws -> remote tcp */ }
        const { error, message, address_type, address, port, offset, version, is_udp }
          = vls_header(chunk, obj.uuid); /* vls request */
        if (error) { throw new Error(`vls header: ${message}`); }
        console.log("vls:", address, port, is_udp ? "UDP" : "TCP" );
        if (is_udp && port !== 53) { throw new Error("UDP only support port 53 for DNS query"); }
        const header = new Uint8Array([ version, 0x00 ]); const data = chunk.slice(offset);
        if (is_udp) { await dns_handle(obj, remote_stream, ws, header); /* udp dns query only */
          remote_stream.writer.write(data); is_dns = true; return; }
        await set_proxyip_config(obj, address, address_type, port);
        tcp_handle(obj, remote_stream, ws, header, address, port, data);
      },
      close() { console.log("readable websocket stream is close"); },
      abort(reason) { console.log("readable websocket stream is abort", reason); }
    })).catch((error) => { console.log("readable websocket stream pipeto error", error); });
  return new Response(null, { status: 101, webSocket: client });
}

function url_params(obj, params) {
  const prefix64 = params.get("prefix64");
  if (prefix64 != null) { console.log("url param prefix64:", prefix64);
    obj.prefix64 = prefix64; }
  const proxyip = params.get("proxyip");
  if (proxyip != null) { console.log("url param proxyip:", proxyip);
    obj.proxyip = proxyip; }
  const is_fproxyip = params.get("is_fproxyip");
  if (is_fproxyip === "1") { console.log("url param is_fproxyip:", is_fproxyip);
    obj.is_fproxyip = is_fproxyip; }
}

export default {
  async fetch(request, env, ctx) {
    try {
      let obj = { };
      obj.uuid = env.opt_uuid || opt_uuid;
      obj.dohurl = env.opt_dohurl || opt_dohurl;
      obj.prefix64 = env.opt_prefix64 || opt_prefix64;
      obj.proxyip = env.opt_proxyip || opt_proxyip;

      const url = new URL(request.url);
      if (request.headers.get("sec-websocket-protocol")) {
        url_params(obj, url.searchParams);
        return await ws_handle(obj, request);
      }

      const hostname = request.headers.get("Host");
      switch (url.pathname) {
        case `/${obj.uuid}`:
          return new Response(get_config(obj.uuid, hostname),
            {
              status: 200,
              headers: {
                "Content-Type": "text/html; charset=utf-8"
              }
            });
        default:
          return new Response(JSON.stringify(request.cf, null, 2),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json;charset=utf-8"
              }
            });
      }
    } catch (error) {
      console.log("fetch error", error);
      return new Response(error.toString());
    }
  }
};

function get_config(uuid, hostname) {
  return `${uuid} ${hostname}`;
}
