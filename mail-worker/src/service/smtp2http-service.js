import emailService from './email-service';
import accountService from './account-service';
import settingService from './setting-service';
import attService from './att-service';
import roleService from './role-service';
import userService from './user-service';
import r2Service from './r2-service';
import telegramService from './telegram-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import emailUtils from '../utils/email-utils';
import verifyUtils from '../utils/verify-utils';
import { attConst, emailConst, isDel, roleConst, settingConst } from '../const/entity-const';

/**
 * 处理 smtp2http (https://github.com/alash3al/smtp2http) 回调的邮件接收
 * 兼容其 JSON 格式: addresses.from/to/cc/bcc, body.html/text, attachments, embedded_files
 */
const smtp2httpService = {

	async receive(c, payload) {
		const {
			receive,
			noRecipient,
			r2Domain,
			ruleEmail,
			ruleType,
			tgBotStatus,
			tgChatId
		} = await settingService.query(c);

		if (receive === settingConst.receive.CLOSE) {
			throw new Error('Service suspended');
		}

		const addresses = payload.addresses || {};
		const from = addresses.from || {};
		const to = Array.isArray(addresses.to) ? addresses.to[0] : addresses.to;
		if (!to || !to.address) {
			throw new Error('Missing recipient address');
		}

		const toEmail = to.address.toLowerCase();
		const account = await accountService.selectByEmailIncludeDel(c, toEmail);

		if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
			throw new Error('Recipient not found');
		}

		let userRow = {};
		if (account) {
			userRow = await userService.selectById(c, account.userId);
		}

		if (account && userRow.email !== c.env.admin) {
			const { banEmail, banEmailType, availDomain } = await roleService.selectByUserId(c, account.userId);
			if (!roleService.hasAvailDomainPerm(availDomain, toEmail)) {
				throw new Error('Mailbox disabled');
			}
			const banList = (banEmail || '').split(',').filter(item => item !== '');
			const fromAddr = (from.address || '').toLowerCase();
			for (const item of banList) {
				if (item === '*') {
					if (!this._banEmailHandler(banEmailType, payload)) {
						throw new Error('Mailbox disabled');
					}
					break;
				}
				if (verifyUtils.isDomain(item)) {
					if (item.toLowerCase() === emailUtils.getDomain(fromAddr)) {
						if (!this._banEmailHandler(banEmailType, payload)) {
							throw new Error('Mailbox disabled');
						}
					}
				} else if (item.toLowerCase() === fromAddr) {
					if (!this._banEmailHandler(banEmailType, payload)) {
						throw new Error('Mailbox disabled');
					}
				}
			}
		}

		const body = payload.body || {};
		let content = body.html || '';
		const text = body.text || '';

		const attachments = [];
		const cidAttachments = [];

		for (const item of payload.attachments || []) {
			const buff = fileUtils.base64ToUint8Array(item.data || '');
			const key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(buff) + fileUtils.getExtFileName(item.filename || '');
			const att = {
				key,
				filename: item.filename || 'attachment',
				mimeType: item.content_type || 'application/octet-stream',
				content: buff,
				size: buff.length,
				type: attConst.type.ATT
			};
			attachments.push(att);
		}

		for (const item of payload.embedded_files || []) {
			const buff = fileUtils.base64ToUint8Array(item.data || '');
			const key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(buff) + fileUtils.getExtFileName('');
			const att = {
				key,
				filename: '',
				mimeType: item.content_type || 'application/octet-stream',
				content: buff,
				size: buff.length,
				contentId: (item.cid || '').replace(/^<|>$/g, ''),
				type: attConst.type.EMBED
			};
			cidAttachments.push(att);
			attachments.push(att);
		}

		const inReplyTo = Array.isArray(addresses.in_reply_to) ? addresses.in_reply_to[0] : (addresses.in_reply_to || '');
		const references = payload.references ? (Array.isArray(payload.references) ? payload.references.join(' ') : payload.references) : '';

		const params = {
			toEmail,
			toName: to.name || emailUtils.getName(toEmail),
			sendEmail: from.address || '',
			name: from.name || emailUtils.getName(from.address || ''),
			subject: payload.subject || '(无主题)',
			content,
			text,
			cc: JSON.stringify(addresses.cc || []),
			bcc: JSON.stringify(addresses.bcc || []),
			recipient: JSON.stringify([to]),
			inReplyTo: inReplyTo || '',
			relation: references,
			messageId: payload.id || '',
			userId: account ? account.userId : 0,
			accountId: account ? account.accountId : 0,
			isDel: isDel.DELETE,
			status: emailConst.status.SAVING
		};

		params.content = emailService.imgReplace(params.content, cidAttachments, r2Domain);

		let emailRow = await emailService.receive(c, params, cidAttachments, r2Domain);

		attachments.forEach(att => {
			att.emailId = emailRow.emailId;
			att.userId = emailRow.userId;
			att.accountId = emailRow.accountId;
		});

		try {
			if (attachments.length > 0 && await r2Service.hasOSS(c)) {
				await attService.addAtt(c, attachments);
			}
		} catch (e) {
			console.error('smtp2http attachment save error:', e);
		}

		emailRow = await emailService.completeReceive(c, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);

		if (ruleType === settingConst.ruleType.RULE && ruleEmail) {
			const ruleEmails = ruleEmail.split(',');
			if (!ruleEmails.includes(toEmail)) {
				return emailRow;
			}
		}

		if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
			try {
				await telegramService.sendEmailToBot(c, emailRow);
			} catch (e) {
				console.error('smtp2http telegram forward error:', e);
			}
		}

		return emailRow;
	},

	_banEmailHandler(banEmailType, payload) {
		if (banEmailType === roleConst.banEmailType.ALL) {
			return false;
		}
		if (banEmailType === roleConst.banEmailType.CONTENT) {
			if (payload.body) {
				payload.body.html = 'The content has been deleted';
				payload.body.text = 'The content has been deleted';
			}
			payload.attachments = [];
			payload.embedded_files = [];
		}
		return true;
	}
};

export default smtp2httpService;
