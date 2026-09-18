import { describe, expect, it } from 'vitest';
import {
  AgentToolSchemas,
  agentToolNamesWithSchema,
  hasAgentToolSchema,
  jsonSchemaFor,
  validateAgentToolInput,
} from '@lumibase/contracts';
import { argsForProperty, validArgsFor } from '../../test-utils/agent-tool-args';

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

  it('skill không có schema thì validArgsFor trả {} và argsForProperty giữ args sinh ngẫu nhiên', () => {
    expect(validArgsFor('listCollections')).toEqual({});
    const generated = { random: 'junk' };
    expect(argsForProperty('listCollections', generated)).toBe(generated);
    expect(argsForProperty('createItem', generated)).not.toBe(generated);
    expect(validateAgentToolInput('createItem', argsForProperty('createItem', generated)).ok).toBe(true);
  });
});
