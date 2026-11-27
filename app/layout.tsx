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
        <script dangerouslySetInnerHTML={{ __html: "function __ffSend(kind,text){try{navigator.sendBeacon('http://127.0.0.1:8791/log',kind+'\\n'+String(text).slice(0,4000));}catch(e){}}__ffSend('boot',location.href);window.addEventListener('error',function(e){__ffSend('error',(e.message||'')+' @ '+(e.filename||'')+':'+(e.lineno||0)+'\\n'+((e.error&&e.error.stack)||''));});window.addEventListener('unhandledrejection',function(e){var r=e.reason;__ffSend('rejection',(r&&(r.stack||r.message))||String(r));});setTimeout(function(){__ffSend('state',document.title+' | '+(document.body?document.body.innerText.slice(0,500):''));},8000);" }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
