import { createLumiClient, graphql, readItems, type ItemRow } from "@lumibase/sdk";
import { RealtimeTester } from "./realtime-tester";

// Khởi tạo client tới CMS (chạy local mặc định port 1989 của Cloudflare worker, hoặc mock)
const cmsUrl =
  process.env.NEXT_PUBLIC_LUMIBASE_URL ||
  process.env.LUMIBASE_URL ||
  "http://127.0.0.1:1989";
const siteId =
  process.env.NEXT_PUBLIC_LUMIBASE_SITE_ID ||
  process.env.LUMIBASE_SITE_ID ||
  "site_demo";
const token =
  process.env.NEXT_PUBLIC_LUMIBASE_TOKEN ||
  process.env.LUMIBASE_TOKEN ||
  "dev:studio";

const client = createLumiClient({
  url: cmsUrl,
  siteId,
  token,
});

// Cùng client, mở rộng thêm adapter GraphQL (Composable `.with`).
const gqlClient = createLumiClient({ url: cmsUrl, siteId, token }).with(graphql());

interface GqlPost {
  id: string;
  title?: string | null;
}

export const dynamic = "force-dynamic";

const withTimeout = async <T,>(promise: Promise<T>, ms: number): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([promise, timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export default async function Home() {
  let posts: ItemRow[] = [];
  let errorMsg = null;

  try {
    // Gọi API thông qua composable command readItems
    const res = await withTimeout(client.request(readItems("posts", { limit: 5 })), 1500);
    posts = (res as { data: ItemRow[] }).data || [];
  } catch (err: unknown) {
    const e = err as Error;
    errorMsg = e.message || "Failed to fetch posts";
  }

  // Cùng dữ liệu nhưng lấy qua GraphQL adapter để minh hoạ `.with(graphql())`.
  let gqlPosts: GqlPost[] = [];
  let gqlError: string | null = null;
  try {
    const res = await withTimeout(
      gqlClient.query<{ posts: GqlPost[] }>(
        `query ($limit: Int) { posts(limit: $limit) { id title } }`,
        { limit: 5 },
      ),
      1500,
    );
    gqlPosts = res.posts || [];
  } catch (err: unknown) {
    gqlError = (err as Error).message || "Failed to fetch posts via GraphQL";
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 py-12 px-6">
      <div className="max-w-4xl mx-auto space-y-12">
        <header className="space-y-4 text-center">
          <h1 className="text-5xl font-extrabold tracking-tight text-slate-900">Lumibase Consumer App</h1>
          <p className="text-slate-500 text-lg max-w-2xl mx-auto">
            Giao diện Next.js App Router (Consumer frontend) để thử nghiệm Lumibase SDK với mô hình Composable.
          </p>
        </header>

        <section className="bg-white p-8 rounded-3xl shadow-sm border border-slate-200">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold tracking-tight">Dữ liệu từ Collection: &ldquo;posts&rdquo;</h2>
            <div className="px-3 py-1 bg-green-100 text-green-700 text-sm font-semibold rounded-full">
              Live
            </div>
          </div>

          {errorMsg ? (
            <div className="p-4 bg-red-50 border border-red-100 text-red-600 rounded-xl">
              <strong className="block mb-1">Lỗi kết nối:</strong> {errorMsg}
            </div>
          ) : posts.length === 0 ? (
            <div className="p-8 text-center bg-slate-50 rounded-xl border border-dashed border-slate-300">
              <p className="text-slate-500 font-medium">Không tìm thấy bài viết nào hoặc backend chưa chạy.</p>
              <p className="text-sm text-slate-400 mt-2">Đảm bảo bạn đã khởi động `apps/cms` ở cổng 1989.</p>
            </div>
          ) : (
            <ul className="grid gap-4">
              {posts.map((post) => (
                <li key={post.id} className="p-5 border border-slate-100 rounded-2xl hover:bg-slate-50 transition-colors shadow-sm">
                  <h3 className="font-bold text-lg">{String(post.data.title || "Bài viết không có tiêu đề")}</h3>
                  <p className="text-slate-600 mt-2 text-sm line-clamp-2">
                    {String(post.data.excerpt || JSON.stringify(post.data))}
                  </p>
                  <div className="flex items-center gap-4 text-xs text-slate-400 mt-4 font-mono">
                    <span>ID: {post.id}</span>
                    <span>Created: {new Date(post.createdAt).toLocaleDateString()}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bg-white p-8 rounded-3xl shadow-sm border border-slate-200">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold tracking-tight">Cùng &ldquo;posts&rdquo; qua GraphQL</h2>
            <div className="px-3 py-1 bg-indigo-100 text-indigo-700 text-sm font-semibold rounded-full">
              .with(graphql())
            </div>
          </div>

          {gqlError ? (
            <div className="p-4 bg-red-50 border border-red-100 text-red-600 rounded-xl">
              <strong className="block mb-1">Lỗi GraphQL:</strong> {gqlError}
            </div>
          ) : gqlPosts.length === 0 ? (
            <div className="p-8 text-center bg-slate-50 rounded-xl border border-dashed border-slate-300">
              <p className="text-slate-500 font-medium">Không có dữ liệu hoặc backend chưa chạy.</p>
            </div>
          ) : (
            <ul className="grid gap-3">
              {gqlPosts.map((post) => (
                <li key={post.id} className="p-4 border border-slate-100 rounded-2xl flex items-center justify-between">
                  <h3 className="font-semibold">{post.title || "Bài viết không có tiêu đề"}</h3>
                  <span className="text-xs text-slate-400 font-mono">{post.id}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <RealtimeTester baseUrl={cmsUrl} siteId={siteId} token={token} />
      </div>
    </main>
  );
}
