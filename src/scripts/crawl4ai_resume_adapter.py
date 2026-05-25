import asyncio
import json
import sys

from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig


def read_payload() -> dict:
    return json.load(sys.stdin)


def build_output(payload: dict, result) -> dict:
    markdown = getattr(result, 'markdown', None)
    fit_markdown = getattr(markdown, 'fit_markdown', '') if markdown is not None else ''
    raw_markdown = getattr(markdown, 'raw_markdown', '') if markdown is not None else ''
    visible_text = fit_markdown or raw_markdown or getattr(result, 'text', '') or payload.get('visibleText', '')

    return {
        'source': {
            'url': payload.get('url', ''),
            'title': payload.get('title', ''),
            'html': payload.get('html', ''),
            'visibleText': visible_text,
            'fetchedAt': payload.get('fetchedAt', ''),
        },
        'metadata': {
            'success': bool(getattr(result, 'success', False)),
            'error': getattr(result, 'error_message', '') or '',
        },
    }


async def run(payload: dict) -> dict:
    browser_config = BrowserConfig(headless=True, verbose=False)
    run_config = CrawlerRunConfig(verbose=False)
    crawler = AsyncWebCrawler(config=browser_config)
    await crawler.start()
    try:
        result = await crawler.aprocess_html(
            url=payload.get('url', ''),
            html=payload.get('html', ''),
            extracted_content='',
            config=run_config,
            screenshot_data='',
            pdf_data='',
            verbose=False,
        )
        return build_output(payload, result)
    finally:
        await crawler.close()


def main() -> int:
    payload = read_payload()
    output = asyncio.run(run(payload))
    json.dump(output, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
