// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

/**
 * Offset pagination over the API's `{ items, page, pageSize, total }` lists.
 */
import { StowError } from './errors.js';
import type { ResponseMeta, WithResponse } from './api-promise.js';

/** The wire shape of a paginated list. */
export interface PageData<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** @internal Fetches one page by number. */
export type PageFetcher<T> = (page: number) => Promise<WithResponse<PageData<T>>>;

/**
 * One page of a list, plus helpers to walk the rest.
 *
 * Iterating a page with `for await` yields every item from this page to the
 * end of the list, fetching further pages as needed.
 *
 * Lists are ordered newest first and paginated by offset, so records created
 * while you iterate can shift items between pages. For an exact export,
 * filter on a fixed window or de-duplicate by `id`.
 */
export class Page<T> implements AsyncIterable<T> {
  /** Items on this page. */
  readonly items: T[];
  /** One-based page number. */
  readonly page: number;
  /** Items per page requested. */
  readonly pageSize: number;
  /** Total matching items across all pages. */
  readonly total: number;
  /** Metadata of the response that produced this page. */
  readonly response: ResponseMeta;
  readonly #fetchPage: PageFetcher<T>;

  // Private, so the declarations publish no constructor: the SDK creates pages.
  private constructor(result: WithResponse<PageData<T>>, fetchPage: PageFetcher<T>) {
    this.items = result.data.items;
    this.page = result.data.page;
    this.pageSize = result.data.pageSize;
    this.total = result.data.total;
    this.response = result.response;
    this.#fetchPage = fetchPage;
  }

  /** @internal */
  static _create<T>(result: WithResponse<PageData<T>>, fetchPage: PageFetcher<T>): Page<T> {
    return new Page(result, fetchPage);
  }

  /** Whether another page follows this one. */
  hasNextPage(): boolean {
    return this.items.length > 0 && this.page * this.pageSize < this.total;
  }

  /**
   * Fetch the next page.
   *
   * @throws {@link StowError} when there is no next page; check
   * {@link Page.hasNextPage} first.
   */
  async getNextPage(): Promise<Page<T>> {
    if (!this.hasNextPage()) {
      throw new StowError('No more pages. Check hasNextPage() before calling getNextPage().');
    }
    return new Page(await this.#fetchPage(this.page + 1), this.#fetchPage);
  }

  /** Yield this page and every page after it. */
  async *iterPages(): AsyncGenerator<Page<T>, void, undefined> {
    yield this;
    let next = this.hasNextPage() ? await this.getNextPage() : undefined;
    while (next !== undefined) {
      yield next;
      next = next.hasNextPage() ? await next.getNextPage() : undefined;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    for await (const page of this.iterPages()) {
      yield* page.items;
    }
  }
}

/**
 * The promise returned by list methods.
 *
 * Await it for the first {@link Page}, or iterate it with `for await` to walk
 * every item across all pages.
 *
 * @example
 * ```ts
 * const first = await stow.members.list({ pageSize: 50 });
 * for await (const member of stow.members.list({ programId })) {
 *   console.log(member.memberCode);
 * }
 * ```
 */
export class PagePromise<T> implements PromiseLike<Page<T>>, AsyncIterable<T> {
  readonly #page: Promise<Page<T>>;

  // Private, so the declarations publish no constructor: the SDK creates these.
  private constructor(fetchPage: PageFetcher<T>, firstPage: number) {
    this.#page = fetchPage(firstPage).then((result) => Page._create(result, fetchPage));
  }

  /** @internal */
  static _create<T>(fetchPage: PageFetcher<T>, firstPage: number): PagePromise<T> {
    return new PagePromise(fetchPage, firstPage);
  }

  then<TResult1 = Page<T>, TResult2 = never>(
    onfulfilled?: ((value: Page<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#page.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<Page<T> | TResult> {
    return this.#page.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<Page<T>> {
    return this.#page.finally(onfinally);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    yield* await this.#page;
  }

  readonly [Symbol.toStringTag] = 'PagePromise';
}
