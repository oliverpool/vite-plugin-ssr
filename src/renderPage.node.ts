import devalue from 'devalue'
import { getErrorPageId, getPageIds, route, isErrorPage, loadPageRoutes, getFilesystemRoute } from './route.shared'
import { renderHtmlTemplate, isHtmlTemplate } from './html.node'
import { getViteManifest, ViteManifest } from './getViteManifest.node'
import { getPageFile, getPageFiles } from './page-files/getPageFiles.shared'
import { getSsrEnv } from './ssrEnv.node'
import { getPreloadTags } from './getPreloadTags.node'
import { posix as pathPosix } from 'path'
import { stringify } from '@brillout/json-s'
import {
  assert,
  assertUsage,
  lowerFirst,
  isCallable,
  slice,
  cast,
  assertWarning,
  hasProp,
  isPageContextUrl,
  normalizePath,
  removePageContextUrlSuffix,
  getUrlPathname,
  getUrlFull,
  isPlainObject,
  getUrlParsed
} from './utils'
import { prependBaseUrl, removeBaseUrl, startsWithBaseUrl } from './baseUrlHandling'

export { renderPage }
export { getPageFunctions }
export { prerenderPage }
export { renderStatic404Page }

async function renderPage(
  pageContext: { url: string } & Record<string, unknown>
): Promise<
  | { nothingRendered: true; renderResult: undefined; statusCode: undefined }
  | {
      nothingRendered: false
      renderResult: string | unknown
      statusCode: 200 | 404 | 500
    }
> {
  assertArguments(...arguments)
  let { url } = pageContext
  assert(url)

  if (url.endsWith('/favicon.ico')) {
    return {
      nothingRendered: true,
      renderResult: undefined,
      statusCode: undefined
    }
  }

  const { urlWithoutOrigin, urlNormalized, isPageContextRequest, hasBaseUrl } = analyzeUrl(url)
  if (!hasBaseUrl) {
    return {
      nothingRendered: true,
      renderResult: undefined,
      statusCode: undefined
    }
  }
  pageContext.url = urlWithoutOrigin
  pageContext.urlNormalized = urlNormalized
  assert(hasProp<string, 'urlNormalized'>(pageContext, 'urlNormalized'))

  const allPageIds = await getPageIds()

  // *** Route ***
  // We use a try-catch because `route()` executes `.page.route.js` source code which is
  // written by the user and may contain errors.
  let routeResult
  try {
    routeResult = await route(pageContext.urlNormalized, allPageIds, pageContext)
  } catch (err) {
    if (isPageContextRequest) {
      return renderPageContextError(err)
    } else {
      return await render500Page(err, allPageIds, pageContext)
    }
  }

  // *** Handle 404 ***
  let statusCode: 200 | 404
  if (!routeResult) {
    if (!isPageContextRequest) {
      await warn404(pageContext.urlNormalized, allPageIds)
    }
    const errorPageId = getErrorPageId(allPageIds)
    if (!errorPageId) {
      warnMissingErrorPage()
      if (isPageContextRequest) {
        return renderPageContext404PageDoesNotExist()
      }
      return {
        nothingRendered: true,
        renderResult: undefined,
        statusCode: undefined
      }
    }
    if (!isPageContextRequest) {
      statusCode = 404
    } else {
      statusCode = 200
    }
    routeResult = { pageId: errorPageId, pageContextAddendum: { is404: true } }
  } else {
    statusCode = 200
  }

  const { pageId, pageContextAddendum } = routeResult
  Object.assign(pageContext, pageContextAddendum)

  // *** Render ***
  // We use a try-catch because `renderPageId()` execute a `*.page.*` file which is
  // written by the user and may contain an error.
  let renderResult
  try {
    renderResult = await renderPageId(pageId, pageContext, false, isPageContextRequest)
  } catch (err) {
    if (isPageContextRequest) {
      return renderPageContextError(err)
    } else {
      return await render500Page(err, allPageIds, pageContext)
    }
  }

  return { nothingRendered: false, renderResult, statusCode }
}

async function renderPageId(
  pageId: string,
  pageContext: PageContext,
  pageContextAlreadyFetched: boolean = false,
  isPageContextRequest: boolean = false
) {
  const renderData = await getRenderData(pageId, pageContext, pageContextAlreadyFetched, false)

  if (isPageContextRequest) {
    const renderResult = serializePageContext(renderData)
    return renderResult
  } else {
    const renderResult = await renderHtmlDocument(renderData)
    return renderResult
  }
}

async function prerenderPage(
  pageId: string,
  pageContext: { url: string } & Record<string, unknown>,
  pageContextAlreadyFetched: boolean,
  pageContextNeeded: boolean
) {
  const { urlNormalized } = analyzeUrl(pageContext.url)
  pageContext.urlNormalized = urlNormalized
  assert(hasProp<string, 'urlNormalized'>(pageContext, 'urlNormalized'))
  const renderData = await getRenderData(pageId, pageContext, pageContextAlreadyFetched, true)
  const htmlDocument = await renderHtmlDocument(renderData)
  assertUsage(
    typeof htmlDocument === 'string',
    "Pre-rendering requires your `html()` hook to return a string. Open a GitHub issue if that's a problem for you."
  )
  if (!pageContextNeeded) {
    return { htmlDocument, pageContextSerialized: null }
  }
  const pageContextSerialized = serializePageContext(renderData)
  return { htmlDocument, pageContextSerialized }
}

async function renderStatic404Page() {
  const allPageIds = await getPageIds()
  const errorPageId = getErrorPageId(allPageIds)
  if (!errorPageId) {
    return null
  }
  const url = '/fake-404-url' // A `url` is needed for `applyViteHtmlTransform`
  const pageContext = { is404: true, url, urlNormalized: url }
  const pageContextNeeded = false // `renderStatic404Page()` is about generating `dist/client/404.html` for static hosts; there is no client-side routing.
  return prerenderPage(errorPageId, pageContext, false, pageContextNeeded)
}

async function getRenderData(
  pageId: string,
  pageContext: PageContext,
  pageContextAlreadyFetched: boolean,
  isPreRendering: boolean
) {
  const { Page, pageFilePath, pageExports } = await getPage(pageId)

  const pageFunctions = await getPageFunctions(pageId)

  addUrlPropsToPageContext(pageContext)
  Object.assign(pageContext, {
    Page,
    pageId,
    pageExports
    /*
    isPreRendering,
    addPageContext: pageFunctions.addPageContextFunction || null,
    render: pageFunctions.renderFunction,
    prerenderFunction: pageFunctions.prerenderFunction || null,
    passToClient: pageFunctions.passToClient || []
    */
  })

  const { addPageContextFunction, passToClient } = pageFunctions
  if (!pageContextAlreadyFetched && addPageContextFunction) {
    assertPageContext(pageContext)
    assert(hasProp(pageContext, 'Page'))
    const pageContextAddendum = await addPageContextFunction.addPageContext(pageContext)
    assertUsage(
      isPlainObject(pageContextAddendum),
      `The \`addPageContext()\` hook exported by ${addPageContextFunction.filePath} should return a plain JavaScript object.`
    )
    Object.assign(pageContext, pageContextAddendum)
  }

  const pageContext__client: Record<string, unknown> = {}
  if (isErrorPage(pageId)) {
    assert(typeof pageContext.is404 === 'boolean')
    const pageProps = (pageContext.pageProps as Record<string, unknown>) || {}
    pageProps.is404 = pageProps.is404 || pageContext.is404
    pageContext.pageProps = pageProps
    passToClient.push(...['pageProps', 'is404'])
  }
  assert(pageContext.pageId === pageId)
  passToClient.push('pageId')
  passToClient.forEach((prop) => {
    pageContext__client[prop] = pageContext[prop]
  })

  return {
    Page,
    pageId,
    pageFilePath,
    pageFunctions,
    pageContext,
    pageContext__client,
    isPreRendering
  }
}

type PageContext = {
  urlNormalized: string
} & Record<string, unknown>
type RenderData = {
  Page: unknown
  pageContext: PageContext
  pageContext__client: Record<string, unknown>
  pageId: string
  pageFilePath: string
  pageFunctions: PageFunctions
  isPreRendering: boolean
}

function serializePageContext({ pageContext__client }: RenderData) {
  const pageContextSerialized = stringify({
    pageContext: pageContext__client
  })
  return pageContextSerialized
}
async function renderHtmlDocument({
  Page,
  pageContext,
  pageContext__client,
  pageId,
  pageFilePath,
  pageFunctions,
  isPreRendering
}: RenderData) {
  const { renderFunction, addPageContextFunction } = pageFunctions

  const { isProduction = false } = getSsrEnv()
  let clientManifest: null | ViteManifest = null
  let serverManifest: null | ViteManifest = null
  if (isPreRendering || isProduction) {
    const manifests = retrieveViteManifest(isPreRendering)
    clientManifest = manifests.clientManifest
    serverManifest = manifests.serverManifest
  }

  assertPageContext(pageContext)
  assert(hasProp(pageContext, 'Page'))
  const renderResult: unknown = await renderFunction.render(pageContext)

  if (!isHtmlTemplate(renderResult)) {
    // Allow user to return whatever he wants in their `render` hook, such as `{redirectTo: '/some/path'}`.
    if (typeof renderResult !== 'string') {
      return renderResult
    }
    assertUsage(
      typeof renderResult !== 'string',
      `The \`render()\` hook exported by ${renderFunction.filePath} returned a string that is an unsafe. Make sure to return a sanitized string by using the \`html\` tag (\`import { html } from 'vite-plugin-ssr'\`).`
    )
  }
  let htmlDocument: string = renderHtmlTemplate(renderResult, renderFunction.filePath)

  // Inject Vite transformations
  const { urlNormalized } = pageContext
  assert(typeof urlNormalized === 'string')
  htmlDocument = await applyViteHtmlTransform(htmlDocument, urlNormalized)

  // Inject pageContext__client
  htmlDocument = injectPageInfo(htmlDocument, pageContext__client, pageId)

  // Inject script
  const browserFilePath = await getBrowserFilePath(pageId)
  const scriptSrc = !isProduction ? browserFilePath : resolveScriptSrc(browserFilePath, clientManifest!)
  htmlDocument = injectScript(htmlDocument, scriptSrc)

  // Inject preload links
  const dependencies = new Set<string>()
  dependencies.add(pageFilePath)
  dependencies.add(browserFilePath)
  dependencies.add(renderFunction.filePath)
  if (addPageContextFunction) dependencies.add(addPageContextFunction.filePath)
  const preloadTags = await getPreloadTags(Array.from(dependencies), clientManifest, serverManifest)
  htmlDocument = injectPreloadTags(htmlDocument, preloadTags)

  return htmlDocument
}

async function getPage(pageId: string) {
  const pageFile = await getPageFile('.page', pageId)
  assert(pageFile)
  const { filePath, loadFile } = pageFile
  const pageExports = await loadFile()
  assertUsage(
    typeof pageExports === 'object' && ('Page' in pageExports || 'default' in pageExports),
    `${filePath} should have a \`export { Page }\` (or a default export).`
  )
  const Page = pageExports.Page || pageExports.default

  return { Page, pageFilePath: filePath, pageExports }
}

type PageFunctions = {
  renderFunction: {
    filePath: string
    render: (arg1: PageContext & { Page: unknown }) => unknown
  }
  addPageContextFunction?: {
    filePath: string
    addPageContext: (arg1: PageContext & { Page: unknown }) => unknown
  }
  prerenderFunction?: {
    filePath: string
    prerender: () => unknown
  }
  passToClient: string[]
}
async function getPageFunctions(pageId: string): Promise<PageFunctions> {
  const serverFiles = await getServerFiles(pageId)

  let renderFunction
  let addPageContextFunction
  let prerenderFunction
  const passToClient: string[] = []

  for (const { filePath, loadFile } of serverFiles) {
    const fileExports = await loadFile()

    assertUsage(
      !('setPageProps' in fileExports),
      "The `setPageProps()` hook is deprecated: instead, return `pageProps` in your `addPageContext()` hook and use `passToClient = ['pageProps']` to pass `context.pageProps` to the browser. See `BREAKING CHANGE` in `CHANGELOG.md`. (You have a `export { setPageProps }` in `" +
        filePath +
        '`.)'
    )

    const render = fileExports.render || fileExports.default?.render
    assertUsage(!render || isCallable(render), `The \`render()\` hook defined in ${filePath} should be a function.`)

    const addPageContext = fileExports.addPageContext || fileExports.default?.addPageContext
    assertUsage(
      !addPageContext || isCallable(addPageContext),
      `The \`addPageContext()\` hook defined in ${filePath} should be a function.`
    )

    const passToClient_ = fileExports.passToClient || fileExports.default?.passToClient
    if (passToClient_) {
      assertUsage(
        Array.isArray(passToClient_) && passToClient_.every((prop) => typeof prop === 'string'),
        `The \`passToClient_\` export defined in ${filePath} should be an array of strings.`
      )
      passToClient.push(...passToClient_)
    }

    const prerender = fileExports.prerender || fileExports.default?.prerender
    assertUsage(
      !prerender || isCallable(prerender),
      `The \`prerender()\` hook defined in ${filePath} should be a function.`
    )

    if (render) {
      renderFunction = renderFunction || { render, filePath }
    }
    if (addPageContext) {
      addPageContextFunction = addPageContextFunction || {
        addPageContext,
        filePath
      }
    }
    if (prerender) {
      prerenderFunction = prerenderFunction || { prerender, filePath }
    }
  }

  assertUsage(
    renderFunction,
    'No `render` function found. Make sure to define a `*.page.server.js` file that exports a `render` function. You can export a `render` function in a file `_default.page.server.js` which will apply as default to all your pages.'
  )

  return {
    renderFunction,
    addPageContextFunction,
    passToClient,
    prerenderFunction
  }
}

async function getBrowserFilePath(pageId: string) {
  const browserFiles = await getBrowserFiles(pageId)
  const browserFile = browserFiles[0]
  const browserFilePath = browserFile.filePath
  return browserFilePath
}
async function getBrowserFiles(pageId: string) {
  let browserFiles = await getPageFiles('.page.client')
  assertUsage(
    browserFiles.length > 0,
    'No *.page.client.* file found. Make sure to create one. You can create a `_default.page.client.js` which will apply as default to all your pages.'
  )
  browserFiles = filterAndSort(browserFiles, pageId)
  return browserFiles
}

async function getServerFiles(pageId: string) {
  let serverFiles = await getPageFiles('.page.server')
  assertUsage(
    serverFiles.length > 0,
    'No *.page.server.* file found. Make sure to create one. You can create a `_default.page.server.js` which will apply as default to all your pages.'
  )
  serverFiles = filterAndSort(serverFiles, pageId)
  return serverFiles
}

function filterAndSort<T extends { filePath: string }>(pageFiles: T[], pageId: string): T[] {
  pageFiles = pageFiles.filter(({ filePath }) => {
    assert(filePath.startsWith('/'))
    assert(!filePath.includes('\\'))
    return filePath.startsWith(pageId) || filePath.includes('/_default')
  })

  // Sort `_default.page.server.js` files by filesystem proximity to pageId's `*.page.js` file
  pageFiles.sort(
    lowerFirst(({ filePath }) => {
      if (filePath.startsWith(pageId)) return -1
      assert(!filePath.includes('\\'))
      assert(!pageId.includes('\\'))
      const relativePath = pathPosix.relative(pageId, filePath)
      assert(!relativePath.includes('\\'))
      const changeDirCount = relativePath.split('/').length
      return changeDirCount
    })
  )

  return pageFiles
}

async function applyViteHtmlTransform(htmlDocument: string, urlNormalized: string): Promise<string> {
  const ssrEnv = getSsrEnv()
  if (ssrEnv.isProduction) {
    return htmlDocument
  }
  htmlDocument = await ssrEnv.viteDevServer.transformIndexHtml(urlNormalized, htmlDocument)
  return htmlDocument
}

function resolveScriptSrc(filePath: string, clientManifest: ViteManifest): string {
  assert(filePath.startsWith('/'))
  assert(getSsrEnv().isProduction)
  const manifestKey = filePath.slice(1)
  const manifestVal = clientManifest[manifestKey]
  assert(manifestVal)
  assert(manifestVal.isEntry)
  let { file } = manifestVal
  assert(!file.startsWith('/'))
  file = normalizePath(file)
  return '/' + file
}

function injectPageInfo(htmlDocument: string, pageContext__client: Record<string, unknown>, pageId: string): string {
  assert(pageContext__client.pageId === pageId)
  const injection = `<script>window.__vite_plugin_ssr__pageContext = ${devalue(pageContext__client)}</script>`
  return injectEnd(htmlDocument, injection)
}

function injectScript(htmlDocument: string, scriptSrc: string): string {
  const injection = `<script type="module" src="${prependBaseUrl(scriptSrc)}"></script>`
  return injectEnd(htmlDocument, injection)
}

function injectPreloadTags(htmlDocument: string, preloadTags: string[]): string {
  const injection = preloadTags.join('')
  return injectBegin(htmlDocument, injection)
}

function injectBegin(htmlDocument: string, injection: string): string {
  const headOpen = /<head[^>]*>/
  if (headOpen.test(htmlDocument)) {
    return injectAtOpeningTag(htmlDocument, headOpen, injection)
  }

  const htmlBegin = /<html[^>]*>/
  if (htmlBegin.test(htmlDocument)) {
    return injectAtOpeningTag(htmlDocument, htmlBegin, injection)
  }

  if (htmlDocument.toLowerCase().startsWith('<!doctype')) {
    const lines = htmlDocument.split('\n')
    return [...slice(lines, 0, 1), injection, ...slice(lines, 1, 0)].join('\n')
  } else {
    return injection + '\n' + htmlDocument
  }
}

function injectEnd(htmlDocument: string, injection: string): string {
  const bodyClose = '</body>'
  if (htmlDocument.includes(bodyClose)) {
    return injectAtClosingTag(htmlDocument, bodyClose, injection)
  }

  const htmlClose = '</html>'
  if (htmlDocument.includes(htmlClose)) {
    return injectAtClosingTag(htmlDocument, htmlClose, injection)
  }

  return htmlDocument + '\n' + injection
}

function injectAtOpeningTag(htmlDocument: string, openingTag: RegExp, injection: string): string {
  const matches = htmlDocument.match(openingTag)
  assert(matches && matches.length >= 1)
  const tag = matches[0]
  const htmlParts = htmlDocument.split(tag)
  assert(htmlParts.length >= 2)

  // Insert `injection` after first `tag`
  const before = slice(htmlParts, 0, 1)
  const after = slice(htmlParts, 1, 0).join(tag)
  return before + tag + injection + after
}

function injectAtClosingTag(htmlDocument: string, closingTag: string, injection: string): string {
  assert(closingTag.startsWith('</'))
  assert(closingTag.endsWith('>'))
  assert(!closingTag.includes(' '))

  const htmlParts = htmlDocument.split(closingTag)
  assert(htmlParts.length >= 2)

  // Insert `injection` before last `closingTag`
  const before = slice(htmlParts, 0, -1).join(closingTag)
  const after = slice(htmlParts, -1, 0)
  return before + injection + closingTag + after
}

function assertArguments(...args: unknown[]) {
  const pageContext = args[0]
  assertUsage(pageContext, '`renderPage(pageContext)`: argument `pageContext` is missing.')
  assertUsage(
    isPlainObject(pageContext),
    `\`renderPage(pageContext)\`: argument \`pageContext\` should be a plain JavaScript object, but you passed a \`pageContext\` with \`pageContext.constructor === ${
      (pageContext as any).constructor
    }\`.`
  )
  assertUsage(
    hasProp(pageContext, 'url'),
    '`renderPage(pageContext)`: The `pageContext` you passed is missing the property `pageContext.url`.'
  )
  assertUsage(
    typeof pageContext.url === 'string',
    '`renderPage(pageContext)`: `pageContext.url` should be a string but we got `typeof pageContext.url === "' +
      typeof pageContext.url +
      '"`.'
  )
  try {
    removeOrigin(pageContext.url)
  } catch (err) {
    assertUsage(
      false,
      '`renderPage(pageContext)`: argument `pageContext.url` should be a URL but we got `url==="' +
        pageContext.url +
        '"`.'
    )
  }
  const len = args.length
  assertUsage(
    len === 1,
    `\`renderPage(pageContext)\`: You passed ${len} arguments but \`renderPage()\` accepts only one argument.'`
  )
}

function warnMissingErrorPage() {
  const { isProduction } = getSsrEnv()
  if (!isProduction) {
    assertWarning(
      false,
      'No `_error.page.js` found. We recommend creating a `_error.page.js` file. (This warning is not shown in production.)'
    )
  }
}
async function warn404(urlNormalized: string, allPageIds: string[]) {
  const { isProduction } = getSsrEnv()
  const relevantPageIds = allPageIds.filter((pageId) => !isErrorPage(pageId))
  assertUsage(
    relevantPageIds.length > 0,
    'No page found. Create a file that ends with the suffix `.page.js` (or `.page.vue`, `.page.jsx`, ...).'
  )
  if (!isProduction && !isFileRequest(urlNormalized)) {
    assertWarning(
      false,
      `No page is matching the URL \`${getUrlPathname(
        urlNormalized
      )}\`. ${await getPagesAndRoutesInfo()}. (This warning is not shown in production.)`
    )
  }
}
async function getPagesAndRoutesInfo(): Promise<string> {
  const allPageIds = await getPageIds()
  const pageRoutes = await loadPageRoutes()
  const relevantPageIds = allPageIds.filter((pageId) => !isErrorPage(pageId))
  return [
    `You defined ${relevantPageIds.length} pages:`,
    relevantPageIds
      .map((pageId, i) => {
        let routeInfo
        let routeSrc
        if (!(pageId in pageRoutes)) {
          routeInfo = `\`${getFilesystemRoute(pageId, allPageIds)}\``
          routeSrc = 'Filesystem Routing'
        } else {
          const { pageRoute, pageRouteFile } = pageRoutes[pageId]
          const pageRouteStringified = truncateString(String(pageRoute).split(/\s/).filter(Boolean).join(' '), 64)
          routeInfo = `\`${pageRouteStringified}\``
          const routeType = typeof pageRoute === 'string' ? 'Route String' : 'Route Function'
          const routeFile = pageRouteFile
          routeSrc = `${routeType} defined in \`${routeFile}\``
        }
        return `(${i + 1}) \`${pageId}.page.*\` with route ${routeInfo} (${routeSrc})`
      })
      .join(', ')
  ].join(' ')
}

function truncateString(str: string, len: number) {
  if (len > str.length) {
    return str
  } else {
    str = str.substring(0, len)
    return str + '...'
  }
}

function isFileRequest(urlNormalized: string) {
  const urlPathname = getUrlPathname(urlNormalized)
  assert(urlPathname.startsWith('/'))
  const paths = urlPathname.split('/')
  const lastPath = paths[paths.length - 1]
  const parts = lastPath.split('.')
  if (parts.length < 2) {
    return false
  }
  const fileExtension = parts[parts.length - 1]
  return /^[a-z0-9]+$/.test(fileExtension)
}

async function render500Page(
  err: unknown,
  allPageIds: string[],
  pageContext: PageContext
): Promise<
  | { nothingRendered: true; renderResult: undefined; statusCode: undefined }
  | { nothingRendered: false; renderResult: string | unknown; statusCode: 500 }
> {
  handleErr(err)

  const errorPageId = getErrorPageId(allPageIds)
  if (errorPageId === null) {
    warnMissingErrorPage()
    return {
      nothingRendered: true,
      renderResult: undefined,
      statusCode: undefined
    }
  }

  Object.assign(pageContext, { is404: false })
  let renderResult
  try {
    renderResult = await renderPageId(errorPageId, pageContext)
  } catch (err) {
    // We purposely swallow the error, because another error was already shown to the user in `handleErr()`.
    // (And chances are high that this is the same error.)
    return {
      nothingRendered: true,
      renderResult: undefined,
      statusCode: undefined
    }
  }
  return { nothingRendered: false, renderResult, statusCode: 500 }
}

function renderPageContextError(err?: unknown): { nothingRendered: false; renderResult: string; statusCode: 500 } {
  if (err) {
    handleErr(err)
  }
  const renderResult = stringify({
    userError: true
  })
  return { nothingRendered: false, renderResult, statusCode: 500 }
}
function renderPageContext404PageDoesNotExist(): { nothingRendered: false; renderResult: string; statusCode: 200 } {
  const renderResult = stringify({
    pageContext404PageDoesNotExist: true
  })
  return { nothingRendered: false, renderResult, statusCode: 200 }
}

function handleErr(err: unknown) {
  const { viteDevServer } = getSsrEnv()
  if (viteDevServer) {
    cast<Error>(err)
    if (err?.stack) {
      viteDevServer.ssrFixStacktrace(err)
    }
  }
  // We ensure we print a string; Cloudflare Workers doesn't seem to properly stringify `Error` objects.
  const errStr = (hasProp(err, 'stack') && String(err.stack)) || String(err)
  console.error(errStr)
}

function retrieveViteManifest(isPreRendering: boolean): { clientManifest: ViteManifest; serverManifest: ViteManifest } {
  // Get Vite manifest
  const { clientManifest, serverManifest, clientManifestPath, serverManifestPath } = getViteManifest()
  const userOperation = isPreRendering
    ? 'running `$ vite-plugin-ssr prerender`'
    : 'running the server with `isProduction: true`'
  assertUsage(
    clientManifest && serverManifest,
    'You are ' +
      userOperation +
      " but you didn't build your app yet: make sure to run `$ vite build && vite build --ssr` before. (Following build manifest is missing: `" +
      clientManifestPath +
      '` and/or `' +
      serverManifestPath +
      '`.)'
  )
  return { clientManifest, serverManifest }
}

function removeOrigin(url: string): string {
  const urlFull = getUrlFull(url)
  return urlFull
}

function addUrlPropsToPageContext(pageContext: PageContext) {
  const { urlNormalized } = pageContext
  assert(typeof urlNormalized === 'string')
  const urlPathname = getUrlPathname(urlNormalized)
  const urlParsed = getUrlParsed(urlNormalized)
  assert(urlPathname.startsWith('/'))
  assert(isPlainObject(urlParsed))
  Object.assign(pageContext, { urlPathname, urlParsed })
}

function assertPageContext(pageContext: PageContext) {
  assert(typeof pageContext.url === 'string')
  assert(typeof pageContext.urlNormalized === 'string')
  assert(typeof pageContext.urlPathname === 'string')
  assert(isPlainObject(pageContext.urlParsed))
  assert(typeof pageContext.pageId === 'string')
}

function analyzeUrl(
  url: string
): { urlWithoutOrigin: string; urlNormalized: string; isPageContextRequest: boolean; hasBaseUrl: boolean } {
  const isPageContextRequest = isPageContextUrl(url)
  if (isPageContextRequest) {
    url = removePageContextUrlSuffix(url)
  }
  const urlWithoutOrigin = url

  url = removeOrigin(url)
  assert(url.startsWith('/'))

  const hasBaseUrl = startsWithBaseUrl(url)
  if (hasBaseUrl) {
    url = removeBaseUrl(url)
  }

  const urlNormalized = url
  return { urlWithoutOrigin, urlNormalized, isPageContextRequest, hasBaseUrl }
}
