(async () => {
  const { chromium, expect } = await import("@playwright/test");
  const { default: nextEnv } = await import("@next/env");
  const { default: postgres } = await import("postgres");
  nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  const databaseUrl = new URL(process.env.DATABASE_URL);
  if (databaseUrl.hostname.endsWith(".pooler.supabase.com") && databaseUrl.port === "5432") databaseUrl.port = "6543";
  console.log("Database connection", { host: databaseUrl.hostname, port: databaseUrl.port });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    const rootResponse = await page.request.get("http://localhost:3000/api/folders?parentId=null");
    console.log("Folder API", rootResponse.status());
    if (!rootResponse.ok()) throw new Error("Folder API failed");
    const root = await rootResponse.json();
    let files = root.files;
    for (const folder of root.folders.slice(0, 3)) {
      if (files.length) break;
      const response = await page.request.get(`http://localhost:3000/api/folders?parentId=${folder.id}`);
      files = (await response.json()).files;
    }
    if (!files.length) throw new Error("No sample files found");
    for (const file of files.slice(0, 3)) {
      const response = await page.request.get(`http://localhost:3000/api/files/${file.id}/view-url`);
      console.log("View URL API", { status: response.status(), type: file.media_type });
      if (!response.ok()) continue;
      const { url } = await response.json();
      const object = await page.request.get(url, { headers: { Range: "bytes=0-1023" } });
      console.log("File bytes", { status: object.status(), bytes: (await object.body()).length, type: object.headers()["content-type"] });
      await expect(object).toBeOK();
    }
    let share;
    const sql = postgres(databaseUrl.toString(), { max: 1, prepare: false, connect_timeout: 10 });
    try {
      [share] = await sql`select token from share_links where expires_at is null or expires_at > now() order by created_at desc limit 1`;
    } finally { await sql.end({ timeout: 2 }); }
    for (const file of files.slice(0, 3)) {
      if (share) break;
      const response = await page.request.get(`http://localhost:3000/api/share-links?fileId=${file.id}`);
      const links = (await response.json()).shareLinks;
      share = links?.find(link => !link.revoked_at && (!link.expires_at || Date.parse(link.expires_at) > Date.now()));
      if (share) break;
    }
    if (!share) {
      for (const folder of root.folders.slice(0, 5)) {
        const response = await page.request.get(`http://localhost:3000/api/share-links?folderId=${folder.id}`);
        const links = (await response.json()).shareLinks;
        share = links?.find(link => !link.revoked_at && (!link.expires_at || Date.parse(link.expires_at) > Date.now()));
        if (share) break;
      }
    }
    if (share) {
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`http://localhost:3000/share/${share.token}`);
      if (!(await page.locator(".yarl__root").count())) await page.locator("button").filter({ has: page.locator("svg") }).first().click();
      await expect(page.locator(".yarl__root")).toBeVisible();
      await expect.poll(() => page.evaluate(() => {
        const media = document.querySelector(".yarl__slide_current img, .yarl__slide_current video");
        return media instanceof HTMLImageElement ? media.complete && media.naturalWidth > 0 : media instanceof HTMLVideoElement && media.readyState >= 2;
      }), { timeout: 20000 }).toBeTruthy();
      expect(errors).toEqual([]);
      console.log("Shared media loaded and rendered without crashing");
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message.split("\n")[0]); process.exitCode = 1; });
