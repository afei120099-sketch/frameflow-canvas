import { fileURLToPath } from "node:url";

/** Local PyAV runtime shared by the rough-cut dialog routes and the Autopilot worker (e.g. the ComfyUI portable embedded Python; nothing installed). Set FRAMEFLOW_PYAV_PYTHON. */
export const PYAV_PYTHON = process.env.FRAMEFLOW_PYAV_PYTHON || "python";
export const ROUGH_CUT_SCRIPT = fileURLToPath(new URL("./rough-cut.py", import.meta.url));
