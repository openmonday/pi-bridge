import test from "node:test";
import assert from "node:assert/strict";
import { NativePanel } from "../src/native-panel.ts";

const helper = String.raw`
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
send({type:'ready'});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const command=JSON.parse(line);
 if(command.type==='show')send({type:'shown',id:command.id});
 if(command.type==='result')send({type:'closed',id:command.id});
 if(command.type==='quit')process.exit(0);
});`;

test("native panel bridge isolates requests, sends text as JSON, and reports dismissal", async () => {
  const panel = new NativePanel(process.execPath, ["-e", helper]);
  try {
    let closed = 0;
    const first = await panel.show('Text with "quotes"\n</script>', "zh-Hans", () => closed++);
    const second = await panel.show("Another selection", "en", () => closed++);
    assert.equal(closed, 1);
    first.result("Stale result");
    assert.equal(closed, 1);
    second.result("Translated text");
    const deadline = Date.now() + 2000;
    while (closed < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(closed, 2);
    second.close();
    assert.equal(closed, 2);
  } finally { panel.dispose(); }
});

test("native panel startup failures are reported and retried", async () => {
  const panel = new NativePanel("/tmp/bridge-missing-helper");
  try { await assert.rejects(panel.show("Text", "en", () => {}), /Could not launch the selection panel/); }
  finally { panel.dispose(); }
});
