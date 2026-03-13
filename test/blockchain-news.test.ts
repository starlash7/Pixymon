import test from "node:test";
import assert from "node:assert/strict";

import { __newsFetchTest, BlockchainNewsService } from "../src/services/blockchain-news.ts";

test("parseRssItems extracts title, summary, and link from rss xml", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title><![CDATA[ETF review window narrows after court filing]]></title>
      <description><![CDATA[<p>Issuers are repricing timeline expectations.</p>]]></description>
      <link>https://example.com/story</link>
    </item>
  </channel></rss>`;

  const items = __newsFetchTest.parseRssItems(xml, "Test RSS", 5);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "ETF review window narrows after court filing");
  assert.match(items[0].summary, /Issuers are repricing timeline expectations/);
  assert.equal(items[0].url, "https://example.com/story");
});

test("getTodayHotNews no longer turns trending rankings into news items", async () => {
  const service = new BlockchainNewsService();
  const items = await service.getTodayHotNews();
  assert.deepEqual(items, []);
});
