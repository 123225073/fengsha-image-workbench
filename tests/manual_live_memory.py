"""Opt-in live-model acceptance through the real application routes (not a unit test).

Uses the configured provider through its normal credential wrapper. Synthetic long
history and an isolated local database keep customer projects and wallet untouched.
Actual upstream token usage is recorded. No search/image requests or automatic retry.
"""
import argparse
from contextlib import closing
from datetime import datetime
import json
from pathlib import Path
import re
import sys
import time
from types import SimpleNamespace
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import commercial_context as context
import commercial_memory as memory
import commercial_workspace as commercial
import workspace_server as server

PROBE = ('这是长对话记忆验收，请只根据前文列出当前最终有效值，逐项作答：两个项目完整链接、指定版本、'
         '受众、预算、部署约束、发布范围、SAG2 与 SAG-Wiki 的关系是否已确认、项目代号、验收口令。'
         '不要复述已废弃的旧值，不要靠常识补全；不知道就明确写不确定。')
WEKNORA = 'https://github.com/Tencent/WeKnora'
SAG = 'https://github.com/Zleap-AI/SAG-Wiki/releases/tag/v0.2.7'


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def filler(start, count):
    topics = ['资料核对', '章节衔接', '评审安排', '来源记录', '阅读顺序', '措辞整理']
    return [{'question': f'背景记录 {i}（不是新的决定）：' +
             (f'这一段讨论{topics[i % len(topics)]}。保持先前已经确认的事实、链接、版本与约束，只整理文字，不新增技术结论。' * 13),
             'reply': '已收到本段背景。' + ('这只是资料整理说明，不代表完成了项目试用，不得据此判断功能优劣，未核实的数据不进入成稿。' * 9)}
            for i in range(start, start + count)]


def initial_history(surface):
    goal = {'ai': '技术选型讨论', 'ppt': '6 页的内部技术交流 PPT', 'poster': '内部技术交流海报，主标题为“知识库试用对比”'}[surface]
    return [
        {'question': f'本会话制作{goal}，对比两个知识库项目。项目链接：{WEKNORA}；'
         'https://github.com/Zlean-AI/SAG-Wiki/releases/tag/v0.2.6 。暂定受众为财务负责人、预算 1000。'
         '项目代号为砺石-724，验收口令为蓝杉-41。', 'reply': '收到，先记录要求，项目功能仍待核实。'},
        {'question': f'重要纠正：上条 SAG 仓库组织名和版本写错了，唯一正确地址是 {SAG}。'
         '受众改为技术负责人，预算改为 2000；不要再使用旧受众或旧预算。'
         '关键决定：只做本地部署试用，不上传公司业务资料到外部平台；仅限内部分享，禁止公开发布。'
         'SAG2 与 SAG-Wiki 的关系尚未核实，不能把二者直接当成同义词。',
         'reply': '接受纠正，以这条的新值为准；项目关系与性能保持待核实。'},
        *filler(2, 24),
    ]


def checks(reply, budget):
    compact = reply.replace(',', '').replace('，', '')
    return {'weknora_url': WEKNORA in reply, 'sag_url': SAG in reply,
            'audience': '技术负责人' in reply and '财务负责人' not in reply,
            'budget': str(budget) in compact,
            'local_deployment': '本地' in reply,
            'private_materials': bool(re.search(r'(?:不上传|不得上传|禁止上传|不得将公司业务资料上传)', reply)) and '业务资料' in reply,
            'internal_only': '内部' in reply and ('禁止公开' in reply or '不公开' in reply or '不得公开' in reply),
            'unconfirmed_relation': 'SAG2' in reply and any(x in reply for x in ['未确认', '未核实', '尚未确认', '待核实']),
            'project_code': '砺石-724' in reply, 'canary': '蓝杉-41' in reply}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-live', action='store_true')
    parser.add_argument('--surface', choices=['all', 'ai', 'ppt', 'poster'], default='all')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if not args.run_live:
        parser.error('Live calls require --run-live and explicit user authorization.')
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if (out / 'calls.json').exists():
        parser.error('This run already has call records. Inspect them before choosing a new run directory; no automatic resubmission.')
    with server.database() as db:
        row = db.execute("SELECT id FROM cpa_models WHERE model_id='gpt-6.1-terra' AND kind='chat' AND enabled=1").fetchone()
        if not row:
            raise RuntimeError('Configured gpt-6.1-terra is not available')
        real_model = server.provider.resolve(db, 'chat', row['id'])
    public_model = {k: real_model.get(k) for k in ['id', 'name', 'model', 'contextWindowTokens', 'contextWindowSource', 'tokenRates']}
    dump(out / 'model.json', public_model)
    server.DATA, server.DATABASE = out / 'storage', out / 'storage' / 'workspace.sqlite3'
    assets = server.setup()
    with server.database() as db:
        db.execute("INSERT INTO users(id,email,name,password,role,points,created) VALUES(1,'live-memory-test@example.invalid','真实摘要验收','unused','admin',2000000,0)")
    # Only configuration resolution is redirected from the isolated DB to the live configuration.
    # Transport, summarization, routes, persistence and billing execute their production code.
    server.provider.resolve = lambda *a, **kw: dict(real_model)
    actual_chat = server.provider.chat
    calls, operations = [], []
    phase = {'surface': '', 'stage': ''}
    spent = 0.0

    def observed_chat(model, messages, *a, **kw):
        nonlocal spent
        receipt = kw.setdefault('receipt', {})
        rates = real_model['tokenRates']
        estimate = (context.message_bytes(messages) * rates['input'] + kw.get('max_output', 4096) * rates['output']) / 1e12
        if spent + estimate > 2:
            raise server.provider.ProviderError(400, '本次真实验收的 2 积分保护预算已用完，停止新增调用。', False)
        index = len(calls) + 1
        kind = 'summary' if messages[0]['content'] == memory.SUMMARY_SYSTEM else 'answer'
        record = {'index': index, **phase, 'kind': kind, 'state': 'started', 'inputEstimate': context.message_bytes(messages), 'started': datetime.now().isoformat()}
        calls.append(record)
        dump(out / 'calls.json', calls)
        dump(out / f'call-{index:02}-input.json', messages)
        print(json.dumps({'call': index, **phase, 'kind': kind, 'state': 'started'}, ensure_ascii=False), flush=True)
        started = time.monotonic()

        def done(text, error=None):
            nonlocal spent
            usage = commercial.token_usage(receipt.get('usage'))
            cost = sum(usage[k] * rates[k] for k in usage) / 1e12 if usage else None
            spent += cost if cost is not None else estimate
            record.update(state='failed' if error else 'completed', seconds=round(time.monotonic() - started, 2),
                          usage=usage, requestId=receipt.get('requestId'), costPoints=cost, error=error)
            dump(out / f'call-{index:02}-output.json', {'text': text, 'receipt': receipt})
            dump(out / 'calls.json', calls)
            print(json.dumps({'call': index, 'kind': kind, 'state': record['state'], 'seconds': record['seconds'], 'usage': usage}, ensure_ascii=False), flush=True)

        try:
            value = actual_chat(model, messages, *a, **kw)
        except Exception as error:
            done('', str(error))
            raise
        if not kw.get('stream'):
            done(value)
            return value

        def stream():
            chunks = []
            error_text = None
            try:
                with closing(value):
                    for chunk in value:
                        chunks.append(chunk)
                        yield chunk
            except Exception as error:
                error_text = str(error)
                raise
            finally:
                done(''.join(chunks), error_text)
        return stream()

    server.provider.chat = observed_chat
    surfaces = ['ai', 'ppt', 'poster'] if args.surface == 'all' else [args.surface]
    for surface in surfaces:
        session = str(uuid.uuid4())
        conversation = uuid.uuid4().hex
        history = initial_history(surface)
        with server.database() as db:
            if surface == 'ai':
                db.execute('INSERT INTO conversations VALUES(?,?,?,?)', (conversation, 1, '真实长对话验收', 0))
        seeded = 0
        for stage, budget in [('compressed', 2000), ('incremental_after_reload', 2600)]:
            if stage != 'compressed':
                history += [{'question': '第二次纠正：预算改为2600，其他决定、项目地址、受众、项目代号和验收口令保持不变。', 'reply': '已更新预算，其他要求不变。'}, *filler(30, 24)]
            phase.update(surface=surface, stage=stage)
            events = []
            body = {'requestId': str(uuid.uuid4()), 'modelId': real_model['id'], 'tokenRates': real_model['tokenRates'],
                    'webSearch': False, 'agent': False, 'sessionId': session, 'researchId': session,
                    'history': history, 'message': PROBE, 'text': PROBE, 'brief': '继续之前的知识库项目对比',
                    'style': '科技', 'level': '标准', 'mode': 'discuss'}
            if surface == 'ai':
                with server.database() as db:
                    for item in history[seeded:]:
                        db.execute("INSERT INTO chat_turns(conversation,request_id,user_text,reply,model_name,price,status,created) VALUES(?,?,?,?,?,0,'succeeded',0)",
                                   (conversation, str(uuid.uuid4()), item['question'], item['reply'], '验收构造的历史'))
                seeded = len(history)
            handler = object.__new__(server.WorkspaceHandler)
            handler.headers = {'Accept': 'application/x-ndjson'}
            handler.server = SimpleNamespace(assets=assets)
            handler.current_user = lambda db: db.execute('SELECT * FROM users WHERE id=1').fetchone()
            handler.json_body = lambda *a: body
            handler.begin_stream = lambda: None
            handler.stream_event = events.append
            handler.log_error = lambda *a: print('Handler error:', a, flush=True)
            path = f'/api/chat/conversations/{conversation}/messages' if surface == 'ai' else '/api/ppt/discuss' if surface == 'ppt' else '/api/poster/advisor'
            error = None
            try:
                with server.database() as db:
                    handler.route(db, 'POST', path)
            except Exception as failure:
                error = str(failure)
            reply = ''.join(e.get('text', '') for e in events if e.get('type') == 'delta')
            errors = [e for e in events if e.get('type') == 'error']
            with server.database() as db:
                rows = [dict(r) for r in db.execute('SELECT scope,summary,covered,revision,transcript FROM conversation_memory')]
            result = {'surface': surface, 'stage': stage, 'historyTurns': len(history), 'reply': reply,
                      'checks': checks(reply, budget), 'events': events, 'error': error or errors,
                      'memories': rows, 'pass': not error and not errors and all(checks(reply, budget).values())}
            operations.append(result)
            dump(out / 'results.json', operations)
            print(json.dumps({k: result[k] for k in ['surface', 'stage', 'historyTurns', 'checks', 'error', 'pass']}, ensure_ascii=False), flush=True)
            if error or errors:
                raise RuntimeError('Live operation failed. Recorded calls must be inspected before another attempt.')
            history.append({'question': PROBE, 'reply': reply})
            if surface == 'ai':
                seeded += 1  # The real route already persisted this turn.
    dump(out / 'summary.json', {'model': public_model, 'operations': len(operations), 'pass': all(x['pass'] for x in operations),
                               'calls': len(calls), 'costPoints': sum(c.get('costPoints') or 0 for c in calls), 'unknownUsageCalls': sum(c.get('usage') is None for c in calls)})
    if not all(x['pass'] for x in operations):
        raise SystemExit('Recall checks need manual review; see recorded answers and summaries.')


if __name__ == '__main__':
    main()
