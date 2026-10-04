// blast-radius tests: `claude plugin test plugins/blast-radius`
// The upstream mod ships no tests; these cover the language pick, the three
// dictionaries and the command classifier (not the measuring or the hold).
//
// The risky command lines are assembled from pieces so that a Bash command
// which writes or greps this file is not itself held by the mod.

import { describe, expect, test } from 'claude-code/testing'

// @ts-ignore plain ES modules of the mod, untyped
import { DEFAULT_LANG, LANGS, MESSAGES, resolveLang, t } from '../hooks/i18n.mjs'
// @ts-ignore
import { classify } from '../hooks/blast-radius.mjs'

const RM_RF = ['rm', '-rf'].join(' ')
const RESET_HARD = ['git reset', '--hard'].join(' ')
const PUSH_FORCE = ['git push', '--force'].join(' ')

describe('resolveLang', () => {
  test('an explicit option wins over the locale', async () => {
    expect(resolveLang('ja', { LANG: 'zh_TW.UTF-8' })).toBe('ja')
    expect(resolveLang('zh-TW', { LANG: 'en_US.UTF-8' })).toBe('zh-TW')
    expect(resolveLang('en', { LANG: 'ja_JP.UTF-8' })).toBe('en')
  })

  test('auto reads LC_ALL, then LC_MESSAGES, then LANG', async () => {
    expect(resolveLang('auto', { LC_ALL: 'ja_JP.UTF-8', LANG: 'zh_TW.UTF-8' })).toBe('ja')
    expect(resolveLang('auto', { LC_MESSAGES: 'zh_TW.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh-TW')
    expect(resolveLang(undefined, { LANG: 'zh_CN.UTF-8' })).toBe('zh-TW')
    expect(resolveLang(undefined, { LANG: 'ja' })).toBe('ja')
    expect(resolveLang(undefined, { LANG: 'de_DE.UTF-8' })).toBe('en')
  })

  test('C, POSIX, empty and unknown options fall back to English', async () => {
    expect(resolveLang('auto', { LANG: 'C' })).toBe(DEFAULT_LANG)
    expect(resolveLang('auto', { LANG: 'C.UTF-8' })).toBe(DEFAULT_LANG)
    expect(resolveLang('auto', { LC_ALL: 'POSIX' })).toBe(DEFAULT_LANG)
    expect(resolveLang('auto', {})).toBe(DEFAULT_LANG)
    expect(resolveLang('fr', { LANG: 'fr_FR.UTF-8' })).toBe(DEFAULT_LANG)
  })
})

describe('messages', () => {
  test('every language has every key', async () => {
    const keys = Object.keys(MESSAGES.en).sort()
    for (const lang of LANGS) expect(Object.keys(MESSAGES[lang]).sort()).toEqual(keys)
  })

  test('zh-TW and ja differ from English for the pane labels and refusals', async () => {
    for (const key of ['proceed', 'cancel', 'waiting', 'whyCancel', 'cleanNothing']) {
      expect(t('zh-TW', key)).not.toBe(t('en', key))
      expect(t('ja', key)).not.toBe(t('en', key))
    }
    expect(t('zh-TW', 'proceed')).toBe('執行')
    expect(t('ja', 'cancel')).toBe('キャンセル')
    expect(t('ja', 'rmFiles', { files: 3, size: '4.0 KB' })).toBe('3 個のファイルを削除（約 4.0 KB）')
    expect(t('zh-TW', 'pushDrops', { ref: 'origin/main', n: 2 })).toBe('強制推送到 origin/main：會蓋掉 2 個 commit')
  })

  test('English keeps its plurals and every refusal carries the English tail', async () => {
    expect(t('en', 'rmFiles', { files: 1, size: '2 KB' })).toBe('delete 1 file (about 2 KB)')
    expect(t('en', 'rmFiles', { files: 2, size: '4 KB' })).toBe('delete 2 files (about 4 KB)')
    for (const lang of LANGS) {
      expect(t(lang, 'deny', { why: 'x', summary: 'y' })).toContain('(blast-radius: the user did not approve this command; do not retry unless asked.)')
      expect(t(lang, 'denyInterrupted')).toContain('do not retry unless asked.')
    }
  })

  test('an unknown language or key falls back', async () => {
    expect(t('fr', 'proceed')).toBe('Proceed')
    expect(t('ja', 'no-such-key')).toBe('no-such-key')
  })
})

describe('classify', () => {
  test('risky commands are classified, harmless ones are not', async () => {
    expect(classify(`${RM_RF} build`)).toEqual({ kind: 'rm', label: RM_RF, targets: ['build'], dir: null })
    expect(classify(RESET_HARD)?.kind).toBe('git-reset')
    expect(classify(`${PUSH_FORCE} origin main`)?.kind).toBe('git-push-force')
    expect(classify('git clean -fdx')?.kind).toBe('git-clean')
    expect(classify(`cd sub && ${RM_RF} dist`)).toEqual({ kind: 'rm', label: RM_RF, targets: ['dist'], dir: 'sub' })
    expect(classify('ls -la')).toBe(null)
    expect(classify('rm file.txt')).toBe(null)
    expect(classify('git status')).toBe(null)
  })
})
