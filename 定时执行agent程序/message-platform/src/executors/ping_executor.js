async function runPingAgent(input) {
  return {
    reply_text: `pong：已收到「${input.clean_text || "ping"}」`,
    session_update: "连通性测试完成。"
  };
}

module.exports = { runPingAgent };
