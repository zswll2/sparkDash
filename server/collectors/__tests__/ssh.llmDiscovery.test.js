/**
 * LLM worker auto-discovery + multi-port health aggregation.
 *
 * The panel's LLM card must follow whichever worker is actually serving: a card
 * pinned to the retired 27B port (5215) while Flash-Next answers on 5217 reads
 * as "LLM down" and its daily chart flat-lines at 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { discoverLlmPorts, llmTestAll, parseListeningPorts } from "../ssh.js";

const SS_OUTPUT = `LISTEN 0 511 192.168.10.100:5555 0.0.0.0:*
LISTEN 0 2048 0.0.0.0:5217 0.0.0.0:*
LISTEN 0 511 [::]:5207 [::]:*
LISTEN 0 2048 127.0.0.1:5215 0.0.0.0:*
LISTEN 0 511 0.0.0.0:5217 0.0.0.0:*
`;

const NETSTAT_OUTPUT = `tcp        0      0 0.0.0.0:8888            0.0.0.0:*               LISTEN
tcp6       0      0 :::5217                 :::*                    LISTEN
`;

test("parseListeningPorts: ss 本地地址在第 4 列，IPv6 与重复行都吃", () => {
  assert.deepEqual(parseListeningPorts(SS_OUTPUT), [5207, 5215, 5217, 5555]);
});

test("parseListeningPorts: netstat 输出同样解析", () => {
  assert.deepEqual(parseListeningPorts(NETSTAT_OUTPUT), [5217, 8888]);
});

test("parseListeningPorts: 垃圾/空输入 → []", () => {
  assert.deepEqual(parseListeningPorts(""), []);
  assert.deepEqual(parseListeningPorts("hello world\nnot a socket line"), []);
});

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original;
    });
}

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const localSpark = (llmPorts) => ({
  isLocal: true,
  lanIp: "127.0.0.1",
  llmPorts,
});

test("llmTestAll: 任一端口活着即健康（停掉的旧端口不该把整机判死）", async () => {
  await withFetch(
    async (url) =>
      String(url).includes(":5217")
        ? jsonRes(200, { data: [{ id: "qwen38-flash-next" }] })
        : jsonRes(500, {}),
    async () => {
      const res = await llmTestAll(localSpark([5215, 5217]));
      assert.equal(res.ok, true);
      assert.deepEqual(res.livePorts, [5217]);
      assert.equal(res.ports.length, 2);
      assert.equal(res.ports[0].port, 5215);
    },
  );
});

test("llmTestAll: 全部端口都不可用 → ok=false，livePorts 空", async () => {
  await withFetch(
    async () => jsonRes(500, {}),
    async () => {
      const res = await llmTestAll(localSpark([5215, 5216]));
      assert.equal(res.ok, false);
      assert.deepEqual(res.livePorts, []);
    },
  );
});

test("discoverLlmPorts: 只留扫描范围内、且匿名能答 /v1/models 的端口（鉴权口是网关，跳过）", async () => {
  const probed = [];
  await withFetch(
    async (url) => {
      const port = Number(String(url).match(/:(\d+)\//)?.[1]);
      probed.push(port);
      if (port === 5207) return jsonRes(401, {}); // llmRouter 要鉴权 → 不是模型 worker
      if (port === 5217)
        return jsonRes(200, { data: [{ id: "qwen38-flash-next" }] });
      return jsonRes(500, {});
    },
    async () => {
      const found = await discoverLlmPorts(localSpark([5215]), {
        start: 5200,
        end: 5299,
        listPorts: async () => [5555, 8888, 5207, 5215, 5217],
      });
      assert.deepEqual(found, [5217]);
      assert.deepEqual(
        probed.sort((a, b) => a - b),
        [5207, 5215, 5217],
      );
    },
  );
});

test("discoverLlmPorts: 端口枚举抛错 → 返回空数组（不把异常抛进轮询循环）", async () => {
  const found = await discoverLlmPorts(localSpark([5215]), {
    listPorts: async () => {
      throw new Error("ss unavailable");
    },
  });
  assert.deepEqual(found, []);
});

test("discoverLlmPorts: 范围内没有监听端口 → 空数组，且不发探测请求", async () => {
  let called = 0;
  await withFetch(
    async () => {
      called += 1;
      return jsonRes(200, {});
    },
    async () => {
      const found = await discoverLlmPorts(localSpark([5215]), {
        start: 5200,
        end: 5299,
        listPorts: async () => [8888],
      });
      assert.deepEqual(found, []);
      assert.equal(called, 0);
    },
  );
});
