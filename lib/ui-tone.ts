/** UI V1: one visual tone per message, so toasts and status lines look consistent everywhere. */
export type Tone = "success" | "warning" | "error" | "info";

const ERROR = /失败|错误|无法|不存在|已失效|丢失|不能|无效|不支持|超过|不兼容|不可用|缺少|拒绝|中止|超时|显存不足|out of memory/i;
const WARNING = /待确认|警告|注意|已取消|取消|请先|请选择|请连接|请填写|等待|未连接|中断|不会重复|已放弃|建议/;
const SUCCESS = /已完成|完成|已加入|已生成|已恢复|已保存|已放到|已采用|成功|已导出|已登记/;

export function toastTone(message: string): Tone {
  if (ERROR.test(message)) return "error";
  if (WARNING.test(message)) return "warning";
  if (SUCCESS.test(message)) return "success";
  return "info";
}
