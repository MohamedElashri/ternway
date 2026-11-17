import { invoke } from "@tauri-apps/api/core";

export const readText = (): Promise<string> => invoke("read_clipboard_text");
export const writeText = (text: string): Promise<void> => invoke("write_clipboard_text", { text });
