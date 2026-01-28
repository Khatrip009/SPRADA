// sitemapService.js
// A clean, reusable sitemap generator service for Node.js / Express

import fs from "fs";
import path from "path";
import { promisify } from "util";
const writeFile = promisify(fs.writeFile);

class SitemapService {
  constructor(options = {}) {
    this.hostname = options.hostname || "https://example.com";
    this.outputDir = options.outputDir || "public";
    this.staticRoutes = options.staticRoutes || [];
  }

  /**
   * Build <url> entries for sitemap
   */
  buildUrlEntry(loc, lastmod = null, changefreq = "weekly", priority = 0.8) {
    return `
      <url>
        <loc>${this.hostname}${loc}</loc>
        ${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}
        <changefreq>${changefreq}</changefreq>
        <priority>${priority}</priority>
      </url>
    `;
  }

  /**
   * Generate full XML sitemap
   */
  async generate(dynamicRoutes = []) {
    const urls = [];

    // Add static routes
    this.staticRoutes.forEach(route => {
      urls.push(this.buildUrlEntry(route));
    });

    // Add dynamic routes
    dynamicRoutes.forEach(item => {
      urls.push(
        this.buildUrlEntry(
          item.loc,
          item.lastmod || new Date().toISOString(),
          item.changefreq || "weekly",
          item.priority || 0.7
        )
      );
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        ${urls.join("\n")}
      </urlset>
    `;

    const outputPath = path.join(this.outputDir, "sitemap.xml");

    await writeFile(outputPath, xml.trim());
    return { success: true, path: outputPath };
  }
}

export default SitemapService;
