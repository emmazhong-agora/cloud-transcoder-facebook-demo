export async function postApi(route, body, settings, fetcher = fetch) {
  const encodedBody = JSON.stringify(body, null, 2);
  const send = () => fetcher(`/api/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lab-Token': settings.csrf },
    body: encodedBody,
  });
  let response = await send();
  let result = await response.json();
  // This local rejection happens before any upstream operation, so one replay is safe.
  if (response.status === 403 && result.code === 'LAB_SESSION_EXPIRED') {
    const configResponse = await fetcher('/api/config', { cache: 'no-store' });
    if (!configResponse.ok) throw new Error('Could not refresh the local session. Try again later.');
    const config = await configResponse.json();
    if (typeof config.csrf !== 'string' || !config.csrf) throw new Error('Invalid local session marker. Reload the page.');
    settings.csrf = config.csrf;
    response = await send();
    result = await response.json();
  }
  return { response, result };
}
