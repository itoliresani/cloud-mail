import app from '../hono/hono';
import result from '../model/result';
import smtp2httpService from '../service/smtp2http-service';

/**
 * SMTP2HTTP 回调接口
 * 用于接收 smtp2http (https://github.com/alash3al/smtp2http) 转发的邮件
 * 配置示例: smtp2http --webhook=https://your-domain/api/smtp2http
 * 可选安全: 设置环境变量 SMTP2HTTP_SECRET，回调 URL 需携带 ?secret=xxx
 */
app.post('/smtp2http', async (c) => {
	const secret = c.env.SMTP2HTTP_SECRET;
	if (secret) {
		const reqSecret = c.req.query('secret');
		if (reqSecret !== secret) {
			return c.json(result.fail('Invalid secret', 401), 401);
		}
	}

	let payload;
	try {
		payload = await c.req.json();
	} catch (e) {
		return c.json(result.fail('Invalid JSON body', 400), 400);
	}

	if (!payload || !payload.addresses) {
		return c.json(result.fail('Invalid smtp2http payload', 400), 400);
	}

	try {
		await smtp2httpService.receive(c, payload);
		return c.json(result.ok());
	} catch (e) {
		console.error('smtp2http receive error:', e);
		return c.json(result.fail(e.message || 'Receive failed', 500), 500);
	}
});
