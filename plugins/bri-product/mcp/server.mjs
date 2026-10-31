#!/usr/bin/env node
import readline from 'node:readline';
import { toolHandlers } from '../lib/tools.mjs';

const SERVER_INFO = { name: 'bri-product', version: '0.2.0' };
const SUPPORTED_PROTOCOL = '2025-06-18';

const TOOLS = [
  {
    name: 'product_sync',
    description:
      '从 ai.bri-king.com 同步产品库到本地。只增不删：服务器新增会下载，服务器更新会覆盖，服务器已删除但本地存在的商品会保留并标记 localOnly。',
    inputSchema: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: '忽略新鲜度检查，强制同步' },
        max_age_hours: { type: 'number', description: '允许的缓存年龄（小时），默认 6' },
        server: { type: 'string', description: '覆盖同步服务器，默认 https://ai.bri-king.com' },
        timeout_ms: { type: 'number', description: '网络超时毫秒数，默认 20000' },
      },
    },
  },
  {
    name: 'product_search',
    description:
      '按关键词、品牌、分类搜索本地产品库，返回 ID、名称、品牌、分类。做图、查商品、找 SKU 的第一步。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，可匹配商品名/品牌/分类' },
        brand: { type: 'string', description: '品牌筛选（包含匹配）' },
        category: { type: 'string', description: '分类筛选（包含匹配）' },
        limit: { type: 'number', description: '返回条数，默认 10，最大 100' },
        offset: { type: 'number', description: '分页偏移，默认 0' },
        offline: { type: 'boolean', description: '只读本地缓存，不触发同步' },
      },
    },
  },
  {
    name: 'product_get',
    description: '按 ID 或名称获取单个商品的完整信息与全部图片 URL。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: '商品 ID' },
        name: { type: 'string', description: '商品名称（精确或唯一包含匹配）' },
        offline: { type: 'boolean', description: '只读本地缓存' },
      },
    },
  },
  {
    name: 'product_images',
    description: '获取商品的包装正面/侧面/中包装/配料表/内物图 URL，不下载图片，不占本地空间。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: '商品 ID' },
        name: { type: 'string', description: '商品名称' },
        fields: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['package_front', 'package_side', 'package_middle', 'ingredient_list', 'product_inner'],
          },
          description: '只返回指定字段，默认全部',
        },
        offline: { type: 'boolean', description: '只读本地缓存' },
      },
    },
  },
  {
    name: 'product_compare',
    description: '对比 2-10 个商品的品牌、分类、渲染状态和五类图片，输出 Markdown 表格与图片链接。',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'number' }, description: '商品 ID 列表' },
        names: { type: 'array', items: { type: 'string' }, description: '商品名称列表' },
        items: {
          type: 'array',
          items: { type: 'string' },
          description: '混合选择器列表（ID 或名称字符串）',
        },
        offline: { type: 'boolean', description: '只读本地缓存' },
      },
    },
  },
  {
    name: 'product_context',
    description:
      '生成做图用的商品上下文：名称、品牌、分类和五张参考图 URL，可直接作为图生图 reference_images。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: '商品 ID' },
        name: { type: 'string', description: '商品名称' },
        offline: { type: 'boolean', description: '只读本地缓存' },
      },
    },
  },
  {
    name: 'product_similar',
    description:
      '按同品牌、同分类和名称相似度推荐同类商品，适合找替代品、做系列化主图或扩品。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: '商品 ID' },
        name: { type: 'string', description: '商品名称' },
        limit: { type: 'number', description: '返回条数，默认 5，最大 50' },
        same_brand_only: { type: 'boolean', description: '只推荐同品牌商品' },
        offline: { type: 'boolean', description: '只读本地缓存' },
      },
    },
  },
  {
    name: 'product_image_audit',
    description:
      '检查商品五类图片（包装正面/侧面/中包装/配料表/内物图）是否齐全，并可选远程核验每个 URL 是否真的能打开。可按商品、品牌、分类或关键词筛选。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: '只检查指定商品 ID' },
        name: { type: 'string', description: '只检查指定商品名称' },
        query: { type: 'string', description: '按关键词筛选商品' },
        brand: { type: 'string', description: '按品牌筛选' },
        category: { type: 'string', description: '按分类筛选' },
        limit: { type: 'number', description: '最多检查多少个商品，默认全部' },
        verify_remote: { type: 'boolean', description: '远程核验图片 URL 是否可访问' },
        remote_limit: { type: 'number', description: '远程核验最多多少个商品，默认 50' },
        concurrency: { type: 'number', description: '远程核验并发数，默认 6' },
        timeout_ms: { type: 'number', description: '单张图核验超时毫秒，默认 10000' },
        item_limit: { type: 'number', description: '不齐全商品列表最多显示多少条，默认 20' },
        broken_limit: { type: 'number', description: '失效图片最多显示多少条，默认 20' },
        offline: { type: 'boolean', description: '只读本地缓存，不触发同步' },
      },
    },
  },
  {
    name: 'product_brands',
    description: '列出产品库全部品牌及商品数量，用于筛选和给运营分配任务。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'product_categories',
    description: '列出产品库全部分类及商品数量。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'product_stats',
    description: '查看产品库状态：商品数、品牌数、分类数、图片齐全度、上次同步时间、索引与图片缓存占用。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'product_export',
    description: '把搜索结果导出为 Markdown 表格、CSV 或 JSON，便于运营批量处理。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词' },
        brand: { type: 'string', description: '品牌筛选' },
        category: { type: 'string', description: '分类筛选' },
        limit: { type: 'number', description: '最多导出条数，默认 100，最大 1000' },
        format: { type: 'string', enum: ['markdown', 'csv', 'json'], description: '导出格式' },
        offline: { type: 'boolean', description: '只读本地缓存' },
      },
    },
  },
  {
    name: 'product_cache_image',
    description:
      '按需把单张商品图下载到本地缓存（默认整库上限 200MB，超限自动淘汰最旧文件），返回本地路径供视觉检查。不要用它批量下载整库图片。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: '商品 ID' },
        name: { type: 'string', description: '商品名称' },
        field: {
          type: 'string',
          enum: ['package_front', 'package_side', 'package_middle', 'ingredient_list', 'product_inner'],
          description: '图片字段，默认 package_front',
        },
        max_cache_mb: { type: 'number', description: '缓存上限 MB，默认 200' },
        offline: { type: 'boolean', description: '只读本地索引（图片仍需联网下载）' },
      },
    },
  },
];

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, payload) {
  writeMessage({ jsonrpc: '2.0', id, result: payload });
}

function error(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    result(id, {
      protocolVersion: requested || SUPPORTED_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions:
        'brking.ai 产品库（504 个商品）：用 product_search 找商品，product_get / product_images 取包装正面/侧面/中包装/配料表/内物图 URL，product_context 生成图生图参考图，product_image_audit 查图片齐全度。默认只读、只增不删；不要批量下载整库图片。',
    });
    return;
  }

  if (method === 'ping') {
    result(id, {});
    return;
  }

  if (method === 'tools/list') {
    result(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    const handler = toolHandlers[name];
    if (!handler) {
      result(id, {
        content: [{ type: 'text', text: `未知工具：${name}` }],
        isError: true,
      });
      return;
    }
    try {
      const text = await handler(args);
      result(id, { content: [{ type: 'text', text: String(text) }], isError: false });
    } catch (toolError) {
      result(id, {
        content: [{ type: 'text', text: `执行失败：${toolError.message}` }],
        isError: true,
      });
    }
    return;
  }

  if (method === 'resources/list') {
    result(id, { resources: [] });
    return;
  }

  if (method === 'prompts/list') {
    result(id, { prompts: [] });
    return;
  }

  error(id, -32601, `不支持的方法：${method}`);
}

let queue = Promise.resolve();

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    error(null, -32700, 'JSON 解析失败');
    return;
  }

  // 通知没有 id，不需要响应。
  if (message.id === undefined || message.id === null) {
    if (message.method === 'notifications/initialized') return;
    return;
  }

  queue = queue.then(() => handleRequest(message)).catch((requestError) => {
    error(message.id, -32603, requestError.message);
  });
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
