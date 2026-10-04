// opsx-board i18n: the UI language, how it is resolved, and every string a person
// or the model reads, in English, Traditional Chinese and Japanese.
// Pure: no `$`. Shared with logic.ts and the tests.

export type Lang = 'en' | 'zh-TW' | 'ja'
export const LANGS: readonly Lang[] = ['en', 'zh-TW', 'ja']
export const DEFAULT_LANG: Lang = 'en'

export type LangEnv = { LC_ALL?: string; LC_MESSAGES?: string; LANG?: string }

/**
 * Picks the language: an explicit option (`en`, `zh-TW`, `ja`) wins; `auto`,
 * undefined or anything else reads LC_ALL, then LC_MESSAGES, then LANG.
 * Any `zh*` locale maps to zh-TW (only Traditional is shipped), `ja*` to ja,
 * everything else (including C, POSIX and empty) to en.
 */
export function resolveLang(option: unknown, env: LangEnv): Lang {
  if (option === 'en' || option === 'zh-TW' || option === 'ja') return option
  for (const raw of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const v = (raw ?? '').trim()
    if (!v) continue
    const low = v.toLowerCase()
    if (low === 'c' || low === 'posix') return 'en'
    if (low.startsWith('zh')) return 'zh-TW'
    if (low.startsWith('ja')) return 'ja'
    return 'en'
  }
  return DEFAULT_LANG
}

export type Params = Record<string, string | number>
type Message = string | ((p: Params) => string)

const en = {
  // groups
  'group.running': 'running',
  'group.waiting': 'waiting',
  'group.done': 'done',
  // agent rows
  'agent.ranFor': (p: Params) => `running ${p.d}`,
  'agent.waitedFor': (p: Params) => `waiting ${p.d}`,
  'agent.failed': (p: Params) => `failed: ${p.reason}`,
  'agent.killed': (p: Params) => `stopped · ${p.d}`,
  'agent.step': (p: Params) => `step ${p.n}`,
  'agent.tools': (p: Params) => `${p.n} tools`,
  'agent.last': (p: Params) => `last ${p.tool}`,
  // toasts
  'toast.spawn': (p: Params) => `▶ ${p.name} started (${p.type})`,
  'toast.done': (p: Params) => `✓ ${p.name} done · ${p.tok} tok · ${p.d}`,
  'toast.killed': (p: Params) => `■ ${p.name} stopped`,
  'toast.failed': (p: Params) => `✗ ${p.name} failed: ${p.reason}`,
  'toast.taskDone': (p: Params) => `✓ ${p.id} ${p.title} · ${p.progress}`,
  // band
  'band.ago': (p: Params) => `${p.d} ago`,
  'band.running': (p: Params) => `⚇ ${p.n} agent${Number(p.n) === 1 ? '' : 's'} running`,
  'band.waiting': (p: Params) => `${p.n} waiting`,
  'band.done': (p: Params) => `${p.n} done`,
  'band.doneOnly': (p: Params) => `⚇ ${p.n} agent${Number(p.n) === 1 ? '' : 's'} done`,
  // pane
  'pane.idle': 'OpenSpec · no opsx flow running (/opsx:propose or /opsx:apply shows the phase here)',
  'pane.inferred': ' (inferred)',
  'pane.allDone': '✓ All tasks done, ready for /opsx:archive',
  'pane.noItems': '  No "- [ ]" items in tasks.md',
  'pane.noTasksYet': '  tasks.md not read yet (it appears once the model reads or edits it)',
  'pane.agentsHead': (p: Params) => `Sub agents · ${p.n} this session · ${p.tok} tok total`,
  'pane.noAgents': 'Sub agents · none yet',
  'pane.group': (p: Params) => `${p.label} (${p.n})`,
  'pane.demo': 'demo mode: fake data (/opsx-board demo to leave)',
  'pane.updated': (p: Params) => `Updated ${p.s}s ago`,
  'pane.noEvents': 'No events yet',
  'pane.currentDeclared': '  current task reported by the model',
  'pane.currentInferred': '  current task inferred from the file',
  'pane.clear': 'Clear finished',
  'pane.close': 'Close',
  // commands
  'cmd.description': 'OpenSpec board: toggle the pane; /opsx-board clear drops finished agents, off pauses, demo shows fake data',
  'cmd.off': 'opsx-board paused (band, pane and status line hidden; events are still recorded). /opsx-board to resume.',
  'cmd.cleared': 'opsx-board: finished sub agents cleared.',
  'cmd.demoOn': 'opsx-board demo mode: fake data. /opsx-board demo again to leave.',
  'cmd.demoOff': 'opsx-board left demo mode.',
  'cmd.usage': 'Usage: /opsx-board (toggle pane), /opsx-board clear (drop finished agents), /opsx-board off (pause), /opsx-board demo (fake data)',
  'cmd.closed': 'opsx-board pane closed (band and status line stay; /opsx-board off pauses).',
  'cmd.opened': 'opsx-board pane opened.',
  'cmd.openedNarrow': 'opsx-board pane opened, but the terminal is too narrow to draw it; widen it and it appears.',
  // tool (model-facing)
  'tool.description':
    'Report OpenSpec task progress (opsx-board). When implementing tasks from tasks.md: call with { task_id, status: "start" } before beginning a task and { task_id, status: "done" } right after finishing it. The tool ticks the checkbox in tasks.md for you; never edit the checkboxes yourself. task_id is the number in tasks.md, e.g. "3.2".',
  'tool.arg.taskId': 'The task number in tasks.md, e.g. "3.2"',
  'tool.arg.status': 'start = beginning this task; done = finished, tick it for me',
  'tool.arg.note': 'Optional one-line note',
  'tool.err.args': 'Both task_id and status (start|done) are required.',
  'tool.err.noTasks': 'tasks.md not found: the current change is unknown. Run /opsx:apply <change> first, or read openspec/changes/<change>/tasks.md once.',
  'tool.err.read': (p: Params) => `Cannot read ${p.file}`,
  'tool.err.unknown': (p: Params) => `No task numbered ${p.id} in tasks.md.`,
  'rule.apply':
    '# opsx-board: task reporting rule\n' +
    'When implementing the tasks.md of an OpenSpec change, call mcp__opsx-board__task {"task_id": "<number>", "status": "start"} before each task ' +
    'and {"task_id": "<number>", "status": "done"} right after finishing it. One task at a time: do not finish several and report them together, ' +
    'and never edit the [ ] / [x] checkboxes in tasks.md yourself (the tool ticks them).',
  'rule.nudge': (p: Params) =>
    `opsx-board: this edit marked ${p.n} tasks done at once. From now on call mcp__opsx-board__task {task_id, status:"done"} after each task so the board shows progress as it happens.`,
  'rule.strictDeny': (p: Params) =>
    `opsx-board (strict mode): this edit would mark ${p.n} tasks done at once and was refused. Use the mcp__opsx-board__task tool instead and report status:"done" after each task; it ticks tasks.md for you.`,
} as const

export type MessageKey = keyof typeof en
export type Messages = Record<MessageKey, Message>

const zhTW: Messages = {
  'group.running': '跑著',
  'group.waiting': '等待中',
  'group.done': '做完',
  'agent.ranFor': p => `跑了 ${p.d}`,
  'agent.waitedFor': p => `等了 ${p.d}`,
  'agent.failed': p => `失敗：${p.reason}`,
  'agent.killed': p => `已停止 · ${p.d}`,
  'agent.step': p => `step ${p.n}`,
  'agent.tools': p => `${p.n} tools`,
  'agent.last': p => `最近 ${p.tool}`,
  'toast.spawn': p => `▶ ${p.name} 開始（${p.type}）`,
  'toast.done': p => `✓ ${p.name} 完成 · ${p.tok} tok · ${p.d}`,
  'toast.killed': p => `■ ${p.name} 已停止`,
  'toast.failed': p => `✗ ${p.name} 失敗：${p.reason}`,
  'toast.taskDone': p => `✓ ${p.id} ${p.title} · ${p.progress}`,
  'band.ago': p => `${p.d} 前`,
  'band.running': p => `⚇ ${p.n} agent${Number(p.n) > 1 ? 's' : ''} 跑著`,
  'band.waiting': p => `${p.n} 等待中`,
  'band.done': p => `${p.n} 做完`,
  'band.doneOnly': p => `⚇ ${p.n} agent${Number(p.n) > 1 ? 's' : ''} 做完`,
  'pane.idle': 'OpenSpec · 沒在跑 opsx 流程（/opsx:propose、/opsx:apply 進入後會顯示階段）',
  'pane.inferred': '（推斷）',
  'pane.allDone': '✓ 全部任務完成，可以 /opsx:archive',
  'pane.noItems': '  tasks.md 裡沒有 - [ ] 項目',
  'pane.noTasksYet': '  還沒讀到 tasks.md（模型讀或改它之後就會出現）',
  'pane.agentsHead': p => `Sub agents · 本 session 共 ${p.n} 個 · 合計 ${p.tok} tok`,
  'pane.noAgents': 'Sub agents · 還沒有 sub agent',
  'pane.group': p => `${p.label}（${p.n}）`,
  'pane.demo': 'demo 模式：假資料（/opsx-board demo 結束）',
  'pane.updated': p => `上次更新：${p.s}s 前`,
  'pane.noEvents': '還沒有事件',
  'pane.currentDeclared': '　目前任務由模型回報',
  'pane.currentInferred': '　目前任務由檔案推斷',
  'pane.clear': '清除已完成',
  'pane.close': '關閉',
  'cmd.description': 'OpenSpec 看板：開關面板；/opsx-board clear 清除做完的 agent、off 暫停、demo 假資料',
  'cmd.off': 'opsx-board 已暫停（band、面板、狀態列都收起；事件仍照常記錄）。/opsx-board 恢復。',
  'cmd.cleared': 'opsx-board：已清除做完的 sub agent。',
  'cmd.demoOn': 'opsx-board demo 模式：假資料。再打 /opsx-board demo 結束。',
  'cmd.demoOff': 'opsx-board 已離開 demo 模式。',
  'cmd.usage': '用法：/opsx-board（開關面板）、/opsx-board clear（清除做完的 agent）、/opsx-board off（暫停）、/opsx-board demo（假資料）',
  'cmd.closed': 'opsx-board 面板已關閉（band 與狀態列照常；/opsx-board off 暫停）。',
  'cmd.opened': 'opsx-board 面板已開啟。',
  'cmd.openedNarrow': 'opsx-board 面板已開啟，但終端機太窄還畫不出來；放寬就會出現。',
  'tool.description':
    'OpenSpec 任務進度回報（opsx-board）。實作 tasks.md 的任務時：開始一個任務前呼叫 { task_id, status: "start" }，做完後立刻呼叫 { task_id, status: "done" }，由本工具把 tasks.md 該行勾成 [x]，不要自己編輯勾選框。task_id 是 tasks.md 裡的編號，例如 "3.2"。',
  'tool.arg.taskId': 'tasks.md 裡的任務編號，例如 "3.2"',
  'tool.arg.status': 'start＝開始做這個任務；done＝做完了，請替我勾選',
  'tool.arg.note': '選填：一句話說明',
  'tool.err.args': 'task_id 與 status（start|done）都要給。',
  'tool.err.noTasks': '找不到 tasks.md：還不知道目前的 change。先用 /opsx:apply <change>，或讀一次 openspec/changes/<change>/tasks.md。',
  'tool.err.read': p => `讀不到 ${p.file}`,
  'tool.err.unknown': p => `tasks.md 裡沒有編號 ${p.id} 的任務。`,
  'rule.apply':
    '# opsx-board：任務回報規則\n' +
    '實作 OpenSpec change 的 tasks.md 時，每個任務開始前呼叫 mcp__opsx-board__task {"task_id": "<編號>", "status": "start"}，' +
    '完成後立刻呼叫 {"task_id": "<編號>", "status": "done"}；一次只做一個任務，不要把多個任務做完再一起回報，' +
    '也不要直接編輯 tasks.md 的 [ ] / [x]（工具會替你勾）。',
  'rule.nudge': p => `opsx-board：這次編輯一次把 ${p.n} 個任務標成完成。之後請每完成一個任務就呼叫 mcp__opsx-board__task {task_id, status:"done"} 回報，看板才能即時顯示進度。`,
  'rule.strictDeny': p => `opsx-board（嚴格模式）：這次編輯會一次把 ${p.n} 個任務標成完成，已拒絕。請改用 mcp__opsx-board__task 工具，每完成一個任務回報一次 status:"done"，工具會替你勾 tasks.md。`,
}

const ja: Messages = {
  'group.running': '実行中',
  'group.waiting': '待機中',
  'group.done': '完了',
  'agent.ranFor': p => `${p.d} 経過`,
  'agent.waitedFor': p => `${p.d} 待機`,
  'agent.failed': p => `失敗：${p.reason}`,
  'agent.killed': p => `停止 · ${p.d}`,
  'agent.step': p => `step ${p.n}`,
  'agent.tools': p => `${p.n} tools`,
  'agent.last': p => `直近 ${p.tool}`,
  'toast.spawn': p => `▶ ${p.name} 開始（${p.type}）`,
  'toast.done': p => `✓ ${p.name} 完了 · ${p.tok} tok · ${p.d}`,
  'toast.killed': p => `■ ${p.name} 停止`,
  'toast.failed': p => `✗ ${p.name} 失敗：${p.reason}`,
  'toast.taskDone': p => `✓ ${p.id} ${p.title} · ${p.progress}`,
  'band.ago': p => `${p.d}前`,
  'band.running': p => `⚇ ${p.n} agent${Number(p.n) > 1 ? 's' : ''} 実行中`,
  'band.waiting': p => `${p.n} 待機中`,
  'band.done': p => `${p.n} 完了`,
  'band.doneOnly': p => `⚇ ${p.n} agent${Number(p.n) > 1 ? 's' : ''} 完了`,
  'pane.idle': 'OpenSpec · opsx フローは動いていません（/opsx:propose や /opsx:apply で段階が表示されます）',
  'pane.inferred': '（推定）',
  'pane.allDone': '✓ 全タスク完了、/opsx:archive できます',
  'pane.noItems': '  tasks.md に - [ ] の項目がありません',
  'pane.noTasksYet': '  tasks.md をまだ読んでいません（モデルが読むか編集すると表示されます）',
  'pane.agentsHead': p => `Sub agents · このセッションで ${p.n} 件 · 合計 ${p.tok} tok`,
  'pane.noAgents': 'Sub agents · まだありません',
  'pane.group': p => `${p.label}（${p.n}）`,
  'pane.demo': 'デモモード：ダミーデータ（/opsx-board demo で終了）',
  'pane.updated': p => `最終更新：${p.s}秒前`,
  'pane.noEvents': 'まだイベントがありません',
  'pane.currentDeclared': '　現在のタスクはモデルの報告',
  'pane.currentInferred': '　現在のタスクはファイルから推定',
  'pane.clear': '完了分を消す',
  'pane.close': '閉じる',
  'cmd.description': 'OpenSpec ボード：ペインの開閉；/opsx-board clear で完了した agent を消去、off で一時停止、demo でダミーデータ',
  'cmd.off': 'opsx-board を一時停止しました（バンド・ペイン・ステータス行を非表示；イベントは記録し続けます）。/opsx-board で再開。',
  'cmd.cleared': 'opsx-board：完了した sub agent を消去しました。',
  'cmd.demoOn': 'opsx-board デモモード：ダミーデータ。もう一度 /opsx-board demo で終了。',
  'cmd.demoOff': 'opsx-board デモモードを終了しました。',
  'cmd.usage': '使い方：/opsx-board（ペイン開閉）、/opsx-board clear（完了した agent を消去）、/opsx-board off（一時停止）、/opsx-board demo（ダミーデータ）',
  'cmd.closed': 'opsx-board ペインを閉じました（バンドとステータス行はそのまま；/opsx-board off で一時停止）。',
  'cmd.opened': 'opsx-board ペインを開きました。',
  'cmd.openedNarrow': 'opsx-board ペインを開きましたが、端末幅が足りず描画できません。広げると表示されます。',
  'tool.description':
    'OpenSpec タスク進捗の報告（opsx-board）。tasks.md のタスクを実装するとき：タスク開始前に { task_id, status: "start" }、完了直後に { task_id, status: "done" } を呼ぶこと。このツールが tasks.md の該当行を [x] にする。チェックボックスを自分で編集しないこと。task_id は tasks.md の番号、例 "3.2"。',
  'tool.arg.taskId': 'tasks.md のタスク番号、例 "3.2"',
  'tool.arg.status': 'start＝このタスクを開始；done＝完了したのでチェックを付けて',
  'tool.arg.note': '任意：一言メモ',
  'tool.err.args': 'task_id と status（start|done）の両方が必要です。',
  'tool.err.noTasks': 'tasks.md が見つかりません：現在の change が不明です。先に /opsx:apply <change> を実行するか、openspec/changes/<change>/tasks.md を一度読んでください。',
  'tool.err.read': p => `${p.file} を読めません`,
  'tool.err.unknown': p => `tasks.md に番号 ${p.id} のタスクはありません。`,
  'rule.apply':
    '# opsx-board：タスク報告ルール\n' +
    'OpenSpec change の tasks.md を実装するときは、各タスクの開始前に mcp__opsx-board__task {"task_id": "<番号>", "status": "start"}、' +
    '完了直後に {"task_id": "<番号>", "status": "done"} を呼ぶこと。一度に一つのタスクだけ扱い、複数をまとめて報告しないこと。' +
    'tasks.md の [ ] / [x] を自分で編集しないこと（ツールがチェックを付ける）。',
  'rule.nudge': p => `opsx-board：この編集で ${p.n} 件のタスクが一度に完了になりました。今後はタスクごとに mcp__opsx-board__task {task_id, status:"done"} で報告してください。ボードが進捗をリアルタイムに表示できます。`,
  'rule.strictDeny': p => `opsx-board（厳格モード）：この編集は ${p.n} 件のタスクを一度に完了にするため拒否しました。代わりに mcp__opsx-board__task ツールでタスクごとに status:"done" を報告してください。ツールが tasks.md にチェックを付けます。`,
}

export const MESSAGES: Record<Lang, Messages> = { en: en as Messages, 'zh-TW': zhTW, ja }

/** Looks a message up in `lang`, falling back to English when the key is missing there. */
export function t(lang: Lang, key: MessageKey, params: Params = {}): string {
  const m = MESSAGES[lang]?.[key] ?? MESSAGES.en[key]
  return typeof m === 'function' ? m(params) : m
}
