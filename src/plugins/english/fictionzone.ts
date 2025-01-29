import { fetchApi } from '@libs/fetch';
import { Plugin } from '@typings/plugin';
import { Filters } from '@libs/filterInputs';
import { load as loadCheerio } from 'cheerio';
import { NovelStatus } from '@libs/novelStatus';
import dayjs from 'dayjs';

//#region Interfaces
interface ChapterResponse {
  _data: Chapter[];
}

interface Chapter {
  title: string;
  slug: string;
  created_at: string;
}

interface NuxtData {
  path: string;
  query: { page: number };
  method: string;
  headers: Record<string, string>;
}

interface CachedNovelId {
  id: string;
  timestamp: number;
}
//#endregion

class FictionZonePlugin implements Plugin.PagePlugin {
  //#region Plugin Metadata
  id = 'fictionzone';
  name = 'Fiction Zone';
  icon = 'src/en/fictionzone/icon.png';
  site = 'https://fictionzone.net';
  version = '1.1.0';
  filters: Filters | undefined = undefined;
  imageRequestInit?: Plugin.ImageRequestInit | undefined = undefined;
  webStorageUtilized?: boolean = false;
  //#endregion

  //#region Cache Management
  private cachedNovelIds = new Map<string, CachedNovelId>();
  private requestCache = new Map<string, Promise<string>>();

  private getCachedId(novelPath: string): string | undefined {
    const entry = this.cachedNovelIds.get(novelPath);
    if (entry && Date.now() - entry.timestamp < 3600000) { // 1 hour TTL
      return entry.id;
    }
    return undefined;
  }

  private setCachedId(novelPath: string, id: string): void {
    this.cachedNovelIds.set(novelPath, {
      id,
      timestamp: Date.now()
    });
  }

  private async cachedFetch(url: string): Promise<string> {
    if (!this.requestCache.has(url)) {
      this.requestCache.set(url, fetchApi(url).then(r => r.text()));
    }
    return this.requestCache.get(url)!;
  }
  //#endregion

  //#region Core Plugin Methods
  async popularNovels(
    pageNo: number,
    options: Plugin.PopularNovelsOptions<typeof this.filters>
  ): Promise<Plugin.NovelItem[]> {
    return this.getPage(this.buildUrl('/library', { page: pageNo }));
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    return this.getPage(
      this.buildUrl('/library', {
        query: searchTerm,
        page: pageNo,
        sort: 'views-all'
      })
    );
  }

  async parseNovel(
    novelPath: string,
  ): Promise<Plugin.SourceNovel & { totalPages: number }> {
    try {
      const body = await this.cachedFetch(this.buildUrl(novelPath));
      const loadedCheerio = loadCheerio(body);

      // Validate critical elements
      const novelTitle = loadedCheerio('div.novel-title > h1').text();
      if (!novelTitle) throw new Error('Novel title not found');

      const novel: Plugin.SourceNovel & { totalPages: number } = {
        path: novelPath,
        name: novelTitle,
        totalPages: 1,
        author: loadedCheerio('div.novel-author > content').text(),
        cover: loadedCheerio('div.novel-img > img').attr('src'),
        genres: [
          ...loadedCheerio('div.genres > .items > span')
            .map((i, el) => loadedCheerio(el).text())
            .toArray(),
          ...loadedCheerio('div.tags > .items > a')
            .map((i, el) => loadedCheerio(el).text())
            .toArray(),
        ].join(','),
        summary: loadedCheerio('#synopsis > div.content').text(),
        chapters: []
      };

      // Handle novel status
      const status = loadedCheerio('div.novel-status > div.content')
        .text().trim();
      novel.status = status === 'Ongoing' ? NovelStatus.Ongoing : NovelStatus.Completed;

      // Extract Nuxt data
      const nuxtData = loadedCheerio('script#__NUXT_DATA__').html();
      if (!nuxtData) throw new Error('Nuxt data not found');
      const parsedData: NuxtData[] = JSON.parse(nuxtData);
      const novelId = parsedData.find(item => 
        typeof item === 'object' && 'path' in item
      )?.path?.split('/').pop();
      if (novelId) this.setCachedId(novelPath, novelId);

      // Parse chapters
      novel.chapters = loadedCheerio(
        'div.chapters > div.list-wrapper > div.items > a.chapter'
      )
        .map((i, el) => {
          const chapterUrl = loadedCheerio(el).attr('href');
          if (!chapterUrl) return null;

          return {
            name: loadedCheerio(el).find('span.chapter-title').text(),
            releaseTime: this.parseAgoDate(
              loadedCheerio(el).find('span.update-date').text()
            ),
            path: chapterUrl.replace(/^\//, '').replace(/\/$/, '')
          };
        })
        .toArray()
        .filter(chap => chap !== null) as Plugin.ChapterItem[];

      // Handle pagination
      novel.totalPages = parseInt(
        loadedCheerio('div.chapters ul.el-pager > li:last-child').text(),
        10
      ) || 1;

      return novel;
    } catch (error) {
      console.error(`[FictionZone] parseNovel error: ${error}`);
      throw error;
    }
  }

  async parsePage(
    novelPath: string,
    page: string
  ): Promise<Plugin.SourcePage> {
    try {
      let novelId = this.getCachedId(novelPath);
      if (!novelId) {
        await this.parseNovel(novelPath);
        novelId = this.getCachedId(novelPath);
      }

      if (!novelId) throw new Error('Failed to retrieve novel ID');

      const response = await fetchApi(this.buildUrl('/api/__api_party/api-v1'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: `/chapter/all/${novelId}`,
          query: { page: parseInt(page) },
          method: 'get',
          headers: { 'content-type': 'application/json' }
        })
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data: ChapterResponse = await response.json();
      
      return {
        chapters: data._data.map(c => ({
          name: c.title,
          releaseTime: new Date(c.created_at).toISOString(),
          path: `${novelPath}/${c.slug}`
        }))
      };
    } catch (error) {
      console.error(`[FictionZone] parsePage error: ${error}`);
      throw error;
    }
  }

  async parseChapter(chapterPath: string): Promise<string> {
    try {
      const body = await this.cachedFetch(this.buildUrl(chapterPath));
      const loadedCheerio = loadCheerio(body);
      const content = loadedCheerio('div.chapter-content').html();

      return this.sanitizeContent(content || '');
    } catch (error) {
      console.error(`[FictionZone] parseChapter error: ${error}`);
      throw error;
    }
  }
  //#endregion

  //#region Helper Methods
  private buildUrl(path: string, params?: Record<string, string | number>): string {
    const url = new URL(path, this.site);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, value.toString());
      });
    }
    return url.toString();
  }

  private sanitizeContent(content: string): string {
    // Basic sanitization - consider using DOMPurify for production
    return content
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/on\w+="[^"]*"/g, '')
      .replace(/<noscript>.*?<\/noscript>/gs, '');
  }

  private parseAgoDate(date?: string): string | null {
    if (!date?.includes('ago')) return null;

    let dayJSDate = dayjs();
    const timeAgo = date.match(/\d+/)?.[0] || '0';
    const timeAgoInt = parseInt(timeAgo, 10);

    const unit = date.includes('hour') ? 'hour' :
      date.includes('day') ? 'day' :
      date.includes('month') ? 'month' :
      date.includes('year') ? 'year' : null;

    if (!unit) return null;

    dayJSDate = dayJSDate.subtract(timeAgoInt, unit as dayjs.ManipulateType);
    return dayJSDate.toISOString();
  }

  resolveUrl = (path: string, isNovel?: boolean) => this.buildUrl(path);
  //#endregion
}

export default new FictionZonePlugin();
