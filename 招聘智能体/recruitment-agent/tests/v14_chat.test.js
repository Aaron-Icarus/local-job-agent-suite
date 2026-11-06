const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDatabase } = require("../src/v14/db");
const chat = require("../src/v14/chat_service");

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v14-chat-"));
  const dbInfo = openDatabase(path.join(root, "jobs.db"));
  t.after(() => {
    dbInfo.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return dbInfo.db;
}

test("对话：缺信息先追问，补全后生成画像", async (t) => {
  const db = setup(t);
  const session = chat.createSession(db, { title: "画像对话" });
  const resume = `# 李四简历
## 目标岗位
实施顾问
## 技能
项目管理、SQL
## 工作经历
5 年企业软件实施经验。
`;
  let result = await chat.runTurn(db, session.id, { text: "看看这份简历", resume_md: resume });
  assert.equal(result.reply.action || result.session.messages.at(-1).metadata.action, "ask_missing");
  assert.ok(result.session.messages.at(-1).metadata.missing.includes("目标城市"));

  result = await chat.runTurn(db, session.id, { text: "城市：上海；薪资：18-25K" });
  const last = result.session.messages.at(-1);
  assert.equal(last.metadata.action, "profile_ready");
  assert.match(last.metadata.profile_md, /实施顾问/);
  assert.match(last.metadata.profile_md, /上海/);
  assert.ok(last.metadata.resume_id);
});

test("对话：按角色查询岗位编号", async (t) => {
  const db = setup(t);
  const session = chat.createSession(db, { title: "岗位对话" });
  const result = await chat.runTurn(db, session.id, { text: "这个角色最近有什么岗位" });
  assert.equal(result.session.messages.at(-1).metadata.action, "need_role");
  assert.match(result.session.messages.at(-1).content, /先选择一个角色/);
});
