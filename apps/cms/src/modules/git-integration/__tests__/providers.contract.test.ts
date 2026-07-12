import { describe, it, expect } from 'vitest';
import { GitHubProvider } from '../providers/github';
import { GitLabProvider } from '../providers/gitlab';
import { parseRepoFullName, ProviderApiError } from '../providers/types';

function jsonResponse(data: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

describe('parseRepoFullName', () => {
  it('splits owner/repo and group/subgroup/repo', () => {
    expect(parseRepoFullName('acme/site')).toEqual({
      owner: 'acme',
      repo: 'site',
    });
    expect(parseRepoFullName('g/sub/proj')).toEqual({
      owner: 'g/sub',
      repo: 'proj',
    });
  });
  it('rejects malformed input', () => {
    expect(() => parseRepoFullName('noslash')).toThrow(ProviderApiError);
  });
});

describe('GitHub + GitLab adapters normalise to the same PullRequest shape', () => {
  const repo = { owner: 'acme', repo: 'site' };

  it('GitHub listPullRequests', async () => {
    const fetchFn = (async () =>
      jsonResponse([
        {
          number: 7,
          title: 'Add hero',
          state: 'open',
          merged_at: null,
          mergeable: true,
          head: { sha: 'abc123' },
          user: { login: 'octocat' },
          updated_at: '2026-01-01T00:00:00Z',
        },
      ])) as unknown as typeof fetch;
    const gh = new GitHubProvider({ token: 't', fetchFn });
    const prs = await gh.listPullRequests(repo);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      number: 7,
      title: 'Add hero',
      state: 'open',
      headSha: 'abc123',
      author: 'octocat',
    });
  });

  it('GitLab listPullRequests (merge requests)', async () => {
    const fetchFn = (async () =>
      jsonResponse([
        {
          iid: 12,
          title: 'Fix nav',
          state: 'opened',
          merge_status: 'can_be_merged',
          sha: 'def456',
          author: { username: 'tanuki' },
          updated_at: '2026-01-02T00:00:00Z',
        },
      ])) as unknown as typeof fetch;
    const gl = new GitLabProvider({ token: 't', fetchFn });
    const prs = await gl.listPullRequests(repo);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      number: 12,
      title: 'Fix nav',
      state: 'open',
      mergeable: true,
      headSha: 'def456',
      author: 'tanuki',
    });
  });

  it('surfaces a ProviderApiError on non-2xx', async () => {
    const fetchFn = (async () =>
      jsonResponse({ message: 'nope' }, false, 401)) as unknown as typeof fetch;
    const gh = new GitHubProvider({ token: 't', fetchFn });
    await expect(gh.listPullRequests(repo)).rejects.toBeInstanceOf(
      ProviderApiError,
    );
  });

  it('getFileContents decodes base64 (GitHub) and returns null on 404', async () => {
    const okFetch = (async () =>
      jsonResponse({
        content: Buffer.from('hello').toString('base64'),
        encoding: 'base64',
      })) as unknown as typeof fetch;
    const gh = new GitHubProvider({ token: 't', fetchFn: okFetch });
    expect(await gh.getFileContents(repo, 'README.md')).toBe('hello');

    const notFound = (async () =>
      jsonResponse({}, false, 404)) as unknown as typeof fetch;
    const gh404 = new GitHubProvider({ token: 't', fetchFn: notFound });
    expect(await gh404.getFileContents(repo, 'missing')).toBeNull();
  });
});
