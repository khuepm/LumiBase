import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CORE_SKILLS as COPILOT_SKILLS } from '@lumibase/ai-skills';
import { describe, expect, it } from 'vitest';
import {
  AgentToolSchemas,
  agentToolNamesWithSchema,
  hasAgentToolSchema,
  jsonSchemaFor,
  validateAgentToolInput,
} from '@lumibase/contracts';
import { CdcSubscriptionCreateSchema } from '@lumibase/contracts/schemas';
import { argsForProperty, validArgsFor } from '../../test-utils/agent-tool-args';
import { intentInputSchema } from '../intent-service';

/**
 * Nguồn schema chuẩn cho agent tool (#454). Test khoá ba tính chất mà phần còn
 * lại của governed contract dựa vào.
 */
describe('AgentToolSchemas', () => {
  it('từ chối đúng các payload từng gây side effect trước khi có validation', () => {
    // Ca đã tái hiện ở `R3`: createItem {} tới được ItemService.create(undefined).
    const empty = validateAgentToolInput('createItem', {});
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.issues.map((i) => i.path).sort()).toEqual(['collection', 'data']);
    }

    // Ca đã tái hiện ở `R5`: deleteItem {} vẫn park được approval.
    expect(validateAgentToolInput('deleteItem', {}).ok).toBe(false);

    // Ca đã tái hiện ở `R4`: createCollection {} tới được SchemaService.
    expect(validateAgentToolInput('createCollection', {}).ok).toBe(false);
  });

  it('nhận payload hợp lệ và trả về data đã parse', () => {
    const ok = validateAgentToolInput('createItem', {
      collection: 'posts',
      data: { title: 'x' },
      status: 'draft',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data).toEqual({ collection: 'posts', data: { title: 'x' }, status: 'draft' });
  });

  it('strict: field lạ bị TỪ CHỐI thay vì rụng âm thầm', () => {
    // Đây là lớp lỗi của `update_item` (REST strip key ngoài envelope ⇒ 200 OK
    // nhưng patch rỗng). Ở tầng schema ta chọn từ chối, không im lặng bỏ.
    const res = validateAgentToolInput('createItem', {
      collection: 'posts',
      data: { title: 'x' },
      title: 'lạc chỗ',
    });
    expect(res.ok).toBe(false);
  });

  it('giữ đúng tên key mà handler đọc — không đổi tên ở tầng schema', () => {
    // `addTeamMember`/`removeTeamMember` đọc `teamId` (không phải `id`), và
    // `replayCdcSubscription` đọc `subscriptionId`. Đổi tên là việc của alias
    // mapping, không phải của schema.
    expect(validateAgentToolInput('addTeamMember', { id: 't1', userId: 'u1' }).ok).toBe(false);
    expect(validateAgentToolInput('addTeamMember', { teamId: 't1', userId: 'u1' }).ok).toBe(true);
    expect(validateAgentToolInput('replayCdcSubscription', { id: 'c1' }).ok).toBe(false);
    expect(validateAgentToolInput('replayCdcSubscription', { subscriptionId: 'c1' }).ok).toBe(true);
  });

  it('skill chưa có schema thì fail-open có chủ ý (không phá hành vi read)', () => {
    expect(hasAgentToolSchema('listCollections')).toBe(false);
    expect(validateAgentToolInput('listCollections', { bất: 'kỳ' }).ok).toBe(true);
  });

  it('jsonSchemaFor suy ra từ đúng Zod và bỏ $schema', () => {
    const json = jsonSchemaFor('createItem')!;
    expect(json['$schema']).toBeUndefined();
    expect(json['type']).toBe('object');
    expect(Object.keys(json['properties'] as object).sort()).toEqual(['collection', 'data', 'status']);
    expect(json['required']).toEqual(expect.arrayContaining(['collection', 'data']));
    expect(jsonSchemaFor('listCollections')).toBeUndefined();
  });

  it('mọi schema khai báo là object và phủ nhóm write chính', () => {
    const names = agentToolNamesWithSchema();
    expect(names.length).toBeGreaterThanOrEqual(30);
    for (const name of names) {
      expect(AgentToolSchemas[name]).toBeDefined();
      const json = jsonSchemaFor(name)!;
      expect(json['type'], `${name} là object schema`).toBe('object');
    }
    // Các skill ghi quan trọng nhất phải có schema — chống việc thêm skill ghi
    // mới mà quên schema.
    for (const must of ['createItem', 'updateItem', 'deleteItem', 'createCollection', 'deleteCollection', 'deleteRole', 'deletePolicy']) {
      expect(names).toContain(must);
    }
  });

  it('mọi schema đều dựng được args hợp lệ bằng bộ candidate của test-utils', () => {
    // `validArgsFor` là thứ các property test dùng để không bị validation chắn
    // ngang. Nó **suy ra** args từ chính schema, nên một schema mới có kiểu field
    // mà bộ candidate không phủ sẽ làm test này đỏ — thay vì âm thầm cấp args rác
    // cho một property khác rồi làm property đó đo sai thứ.
    for (const name of agentToolNamesWithSchema()) {
      const args = validArgsFor(name);
      const verdict = validateAgentToolInput(name, args);
      expect(verdict.ok, `${name}: ${JSON.stringify(args)}`).toBe(true);
    }
  });

  it('fixture canonical mà packages/mcp-server dùng vẫn khớp Zod sống', () => {
    /**
     * Nửa còn lại của gate ở
     * `packages/mcp-server/src/__tests__/governed-binding-contract.test.ts`.
     *
     * Package đó KHÔNG phụ thuộc `@lumibase/contracts` (nó publish với đúng MCP
     * SDK + zod), nên nó so binding governed với một **fixture đã commit**. Fixture
     * chỉ đáng tin nếu có ai đó chứng minh nó chưa trôi lệch so với schema thật —
     * đó là việc của test này, vì đây là chỗ import được cả hai. Thiếu một trong
     * hai nửa thì vòng kiểm không đóng: nửa kia sẽ vui vẻ so với một bản chụp cũ.
     *
     * Sinh lại bằng cách in `jsonSchemaFor` cho `agentToolNamesWithSchema()` —
     * đúng hai field `properties` + `required`, đã sort.
     */
    const fixturePath = fileURLToPath(
      new URL('../../../../../packages/mcp-server/src/__tests__/canonical-agent-tool-schemas.json', import.meta.url),
    );
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<
      string,
      { properties: string[]; required: string[] }
    >;

    const live: Record<string, { properties: string[]; required: string[] }> = {};
    for (const name of agentToolNamesWithSchema().sort()) {
      const json = jsonSchemaFor(name)!;
      live[name] = {
        properties: Object.keys((json['properties'] ?? {}) as object).sort(),
        required: ((json['required'] ?? []) as string[]).slice().sort(),
      };
    }

    expect(fixture).toEqual(live);
  });

  it('mười skill của nhóm `no-canonical-contract` nay đều có schema chuẩn', () => {
    // Nhóm (b) của backlog B70: skill có sẵn, thiếu entry trong AgentToolSchemas.
    // Có schema rồi thì harness mới validate được — với HTTP MCP là ngay lập tức,
    // với stdio là điều kiện cần để route.
    for (const name of [
      'createRelation',
      'createFlow',
      'createIntent',
      'updateTranslation',
      'createWebhook',
      'updateWebhook',
      'installExtension',
      'updateExtension',
      'createCdcSubscription',
      'deleteCdcSubscription',
    ]) {
      expect(hasAgentToolSchema(name), name).toBe(true);
    }
  });

  it('skill không có schema thì validArgsFor trả {} và argsForProperty giữ args sinh ngẫu nhiên', () => {
    expect(validArgsFor('listCollections')).toEqual({});
    const generated = { random: 'junk' };
    expect(argsForProperty('listCollections', generated)).toBe(generated);
    expect(argsForProperty('createItem', generated)).not.toBe(generated);
    expect(validateAgentToolInput('createItem', argsForProperty('createItem', generated)).ok).toBe(true);
  });
});

/**
 * Nhóm `no-canonical-contract` (#454 follow-up, B70 nhóm b). Mỗi schema mới được
 * đo theo ba câu hỏi: key có đúng tên handler đọc không, key lạ có bị TỪ CHỐI
 * không, và ràng buộc top-level có khớp với đường REST/service tương ứng không.
 */
describe('AgentToolSchemas · nhóm no-canonical-contract', () => {
  const reject = (name: string, args: Record<string, unknown>) =>
    expect(validateAgentToolInput(name, args).ok, `${name} phải từ chối ${JSON.stringify(args)}`).toBe(false);
  const accept = (name: string, args: Record<string, unknown>) => {
    const verdict = validateAgentToolInput(name, args);
    expect(verdict.ok, `${name} phải nhận ${JSON.stringify(args)}: ${JSON.stringify(verdict)}`).toBe(true);
  };

  it('key lạ bị từ chối ở MỌI schema mới — kể cả key trùng tên cột bảng', () => {
    // `siteId`/`isOfficial`/`verifiedAt`/`id` là cột thật: các handler update
    // spread patch vào `.set()` và createRelation spread input vào insert, nên
    // với schema không strict chúng đi thẳng tới câu lệnh SQL.
    reject('updateWebhook', { id: 'wh_1', siteId: 'site_other' });
    reject('updateTranslation', { id: 'tr_1', siteId: 'site_other' });
    reject('updateExtension', { id: 'ext_1', siteId: null });
    reject('updateExtension', { id: 'ext_1', isOfficial: true });
    reject('updateExtension', { id: 'ext_1', verifiedAt: '2026-01-01T00:00:00Z' });
    reject('createRelation', { manyCollection: 'posts', manyField: 'author', oneCollection: 'authors', id: 'rel_x' });

    for (const name of [
      'createRelation',
      'createFlow',
      'createIntent',
      'updateTranslation',
      'createWebhook',
      'updateWebhook',
      'installExtension',
      'updateExtension',
      'createCdcSubscription',
      'deleteCdcSubscription',
    ]) {
      const valid = validArgsFor(name);
      accept(name, valid);
      reject(name, { ...valid, bogusField: 'x' });
    }
  });

  it('giữ đúng tên key handler đọc (camelCase), không nhận bản snake_case của REST', () => {
    // deleteCdcSubscription đọc `subscriptionId`; stdio gửi `id` và đổi tên ở
    // tầng binding (`governed.ts`), không phải ở đây.
    reject('deleteCdcSubscription', { id: 'sub_1' });
    accept('deleteCdcSubscription', { subscriptionId: 'sub_1' });
    // createCdcSubscription đọc `webhookId`/`extensionName`, không phải
    // `webhook_id`/`extension_name` của body REST.
    reject('createCdcSubscription', { name: 'feed', kind: 'webhook', webhook_id: 'wh_1' });
    accept('createCdcSubscription', { name: 'feed', kind: 'webhook', webhookId: 'wh_1' });
  });

  it('createCdcSubscription: không khai `payloadMode` vì handler không chuyển tiếp nó', () => {
    // Khai ra thì một yêu cầu `snapshot` sẽ được nhận rồi tạo subscription
    // `reference` — đúng lớp lỗi "nhận rồi rụng âm thầm".
    reject('createCdcSubscription', { name: 'feed', kind: 'pull', payloadMode: 'snapshot' });
    reject('createCdcSubscription', { name: 'feed', kind: 'pull', payload_mode: 'snapshot' });
  });

  it('createCdcSubscription: điều kiện theo `kind` khớp CdcSubscriptionCreateSchema mà handler parse lại', () => {
    // Ánh xạ y như handler trong ai-harness.ts trước khi gọi `.parse`.
    const mapped = (args: Record<string, unknown>) =>
      CdcSubscriptionCreateSchema.safeParse({
        name: args['name'],
        kind: args['kind'],
        collections: args['collections'] ?? [],
        operations: args['operations'] ?? [],
        webhook_id: args['webhookId'],
        extension_name: args['extensionName'],
      }).success;

    const samples: Array<Record<string, unknown>> = [
      { name: 'feed', kind: 'pull' },
      { name: 'feed', kind: 'webhook' },
      { name: 'feed', kind: 'webhook', webhookId: 'wh_1' },
      { name: 'feed', kind: 'extension' },
      { name: 'feed', kind: 'extension', extensionName: 'search-sync' },
      { name: 'feed', kind: 'pull', collections: [''] },
      { name: 'feed', kind: 'pull', operations: ['upsert'] },
      { name: 'x'.repeat(129), kind: 'pull' },
      { name: 'feed', kind: 'stream' },
    ];
    for (const sample of samples) {
      expect(validateAgentToolInput('createCdcSubscription', sample).ok, JSON.stringify(sample)).toBe(mapped(sample));
    }

    const missingWebhook = validateAgentToolInput('createCdcSubscription', { name: 'feed', kind: 'webhook' });
    expect(missingWebhook.ok).toBe(false);
    if (!missingWebhook.ok) expect(missingWebhook.issues.map((i) => i.path)).toEqual(['webhookId']);
  });

  it('createIntent: ràng buộc top-level khớp intentInputSchema; nội dung rule do service kiểm', () => {
    const rule = { type: 'freshness', maxAgeDays: 30 };
    const base = { name: 'Fresh', collection: 'posts', rules: [rule], schedule: '0 * * * *' };
    const samples: Array<Record<string, unknown>> = [
      base,
      { ...base, rules: [] },
      { ...base, rules: Array.from({ length: 51 }, () => rule) },
      { ...base, schedule: 'hourly' },
      { ...base, name: '' },
      { ...base, name: 'x'.repeat(121) },
      { ...base, collection: 'x'.repeat(121) },
      { ...base, autonomyCap: 5 },
      { ...base, autonomyCap: 1.5 },
      { ...base, autonomyCap: 0 },
      { ...base, maintenanceWindow: null },
    ];
    for (const sample of samples) {
      expect(validateAgentToolInput('createIntent', sample).ok, JSON.stringify(sample)).toBe(
        intentInputSchema.safeParse(sample).success,
      );
    }

    // Cố ý lỏng hơn ở tầng này: DSL rule không bị nhân bản vào contracts.
    // IntentService.create parse lại bằng intentInputSchema nên rule sai vẫn bị
    // từ chối — chỉ là ở service, không phải ở ranh giới.
    const opaqueRule = { ...base, rules: [{ type: 'no_such_rule' }] };
    expect(validateAgentToolInput('createIntent', opaqueRule).ok).toBe(true);
    expect(intentInputSchema.safeParse(opaqueRule).success).toBe(false);
  });

  it('installExtension/updateExtension: cùng cổng giao thức bundleUrl với POST /extensions', () => {
    const base = { name: 'Search sync', version: '1.0.0', type: 'hook' };
    accept('installExtension', { ...base, bundleUrl: 'https://cdn.example.com/ext.js' });
    accept('installExtension', { ...base, bundleUrl: 'http://localhost:8080/ext.js' });
    accept('installExtension', { ...base, bundleUrl: 'data:text/javascript,export default {}' });
    reject('installExtension', { ...base, bundleUrl: 'javascript:alert(1)' });
    reject('installExtension', { ...base, bundleUrl: 'file:///etc/passwd' });
    reject('installExtension', { ...base, bundleUrl: 'data:text/html,<script></script>' });
    reject('installExtension', { ...base, bundleUrl: 'not a url' });
    // type là enum slot như route, không phải chuỗi tự do.
    reject('installExtension', { ...base, type: 'operation', bundleUrl: 'https://cdn.example.com/ext.js' });
    // Patch cũng qua cùng cổng.
    reject('updateExtension', { id: 'ext_1', bundleUrl: 'javascript:alert(1)' });
    accept('updateExtension', { id: 'ext_1', enabled: true });
  });

  it('createWebhook/updateWebhook: url phải là URL, status là enum', () => {
    accept('createWebhook', { name: 'Rebuild', url: 'https://hooks.example.com/rebuild' });
    reject('createWebhook', { name: 'Rebuild', url: 'hooks.example.com' });
    reject('createWebhook', { name: '', url: 'https://hooks.example.com/rebuild' });
    reject('createWebhook', { name: 'x'.repeat(256), url: 'https://hooks.example.com/rebuild' });
    reject('updateWebhook', { id: 'wh_1', status: 'paused' });
    accept('updateWebhook', { id: 'wh_1', secret: null });
  });

  it('mô tả tool của Copilot (@lumibase/ai-skills) không hứa property mà schema chuẩn từ chối', () => {
    // `llm-provider.ts` đưa `parameters` của `@lumibase/ai-skills` cho LLM làm
    // định nghĩa tool, còn harness validate bằng schema chuẩn. Mô tả khai một
    // property schema không nhận ⇒ Copilot bị dẫn thẳng vào `VALIDATION`; thiếu
    // một property required ⇒ LLM không biết phải gửi nó. Một ngoại lệ có sẵn từ
    // trước, đã log (B91) — danh sách này chỉ được co lại.
    const KNOWN: Record<string, string[]> = { createCollection: ['description'] };
    const offences: string[] = [];
    for (const name of agentToolNamesWithSchema()) {
      const json = jsonSchemaFor(name)!;
      const accepted = Object.keys((json['properties'] ?? {}) as object);
      const required = (json['required'] ?? []) as string[];
      const descriptor = COPILOT_SKILLS[name];
      if (descriptor === undefined) {
        offences.push(`${name}: không có mô tả Copilot`);
        continue;
      }
      const advertised = Object.keys(descriptor.parameters.properties);
      const extra = advertised.filter((p) => !accepted.includes(p) && !(KNOWN[name] ?? []).includes(p));
      const unreachable = required.filter((r) => !advertised.includes(r));
      if (extra.length > 0) offences.push(`${name}: mô tả khai ${extra.join(', ')} nhưng schema từ chối`);
      if (unreachable.length > 0) offences.push(`${name}: required ${unreachable.join(', ')} không có trong mô tả`);
    }
    expect(offences).toEqual([]);
  });

  it('createFlow: graph bắt buộc, node giữ được key editor như `position`', () => {
    reject('createFlow', { name: 'Notify', triggerType: 'manual' });
    reject('createFlow', { name: 'Notify', triggerType: 'cron', graph: {} });
    accept('createFlow', {
      name: 'Notify',
      triggerType: 'manual',
      graph: { entry: 'n1', nodes: [{ id: 'n1', key: 'log', next: null, position: { x: 0, y: 0 } }] },
    });
    // Node thiếu `key` thì không phải FlowNode.
    reject('createFlow', { name: 'Notify', triggerType: 'manual', graph: { nodes: [{ id: 'n1' }] } });
  });
});
