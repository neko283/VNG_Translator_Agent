import type { PDFPageUpdate } from "../../shared/pdf";

export type AgentWorkspacePageUpdateIntent = Readonly<
  PDFPageUpdate & {
    file_path: string; // 与原稿页码共同定位页面。
    page: number; // 从 1 开始的原稿页码。
    fp: string; // 快照中的页面事实指纹。
    line: number; // 变更清单中的物理行号。
  }
>;
