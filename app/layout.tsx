import type { Metadata } from "next";
import "./globals.css";
import "./tokens.css";
import "./theme-atelier.css";
import "./panels.css";
import {RESIZE_NOTICE_GUARD_SCRIPT} from '@/lib/resize-notice-guard';

export const metadata: Metadata = {
  title: "Frameflow · AI 视频创作画布",
  description: "本地优先的 AI 视频创作无限画布。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        <script dangerouslySetInnerHTML={{__html:RESIZE_NOTICE_GUARD_SCRIPT}} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
