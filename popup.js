document.getElementById("clear").onclick = async () => {
  const result = await chrome.runtime.sendMessage({ type: "LX_FORMAL_CLEAR" }).catch((error) => ({ ok: false, error: error.message }));
  document.getElementById("clear").textContent = result?.ok ? "已清空" : `失败：${result?.error || "未知错误"}`;
};
