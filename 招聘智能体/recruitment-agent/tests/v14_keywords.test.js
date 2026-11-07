const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDatabase } = require("../src/v14/db");
const keywordService = require("../src/v14/keyword_service");
const roles = require("../src/v14/roles_repo");

test("关键词：推荐/兜底分离并写入角色记录", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v14-keywords-"));
  const info = openDatabase(path.join(root, "jobs.db"));
  t.after(() => {
    info.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const role = roles.createRole(info.db, {
    nickname: "AI项目交付",
    target_roles: "AI项目经理, AI产品经理",
    target_city: "上海",
    target_salary: "18-30K",
  });
  assert.equal(role.role_keywords.length, 0);

  const generated = keywordService.fallbackKeywords({
    target_roles: role.target_roles,
    career_expectation: "AI Agent",
    profile_md: "AI 智能体项目交付",
  });
  assert.ok(generated.recommended.length > 0);
  assert.ok(generated.fallback.length > 0);

  keywordService.save(info.db, role.role_uuid, generated);
  const entries = keywordService.list(info.db, role.role_uuid);
  assert.ok(entries.some((item) => item.category === "recommended" && item.is_current));
  assert.ok(entries.some((item) => item.category === "fallback" && item.is_current));
  const updated = roles.getRole(info.db, role.role_uuid);
  assert.ok(updated.role_keywords.includes(generated.recommended[0]));
});
