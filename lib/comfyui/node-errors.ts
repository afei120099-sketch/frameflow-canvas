/** Show validation reasons, not just node IDs; never dump input dictionaries or credentials. */
export function formatComfyNodeErrors(value: Record<string, unknown> | undefined) {
  return Object.entries(value ?? {}).map(([id, entry]) => {
    const record=entry && typeof entry==='object' ? entry as {class_type?:unknown;errors?:unknown} : {};
    const errors=Array.isArray(record.errors)?record.errors:[];
    const details=errors.flatMap(item=>{
      if(!item || typeof item!=='object')return [];
      return ['message','details'].flatMap(key=>typeof item[key]==='string'?[item[key]]:[]);
    });
    const text=[...new Set(details)].join('；').replace(/((?:api[_ -]?key|token|secret|authorization)["']?\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;；]+)/gi,'$1已隐藏').slice(0,600);
    return `节点 ${id}${typeof record.class_type==='string'?` (${record.class_type})`:''}：${text || '校验失败，服务未给出具体原因'}`;
  }).join('\n');
}
