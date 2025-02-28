/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

/* **
 * Lazy getters
 */
/* global DTM, Mediator, Version, Preferences, recognizeTextLinks, TextLinks */
/* global ContentHandling, CoThreads, getIcon, bundle, isWindowPrivate, identity */
/*jshint strict:true, globalstrict:true, -W083, -W003*/
lazy(this, 'DTM', () => require("api"));
lazy(this, "Mediator", () => require("support/mediator"));
lazy(this, 'Version', () => require("version"));
lazy(this, 'Preferences', () => require("preferences"));
this.__defineGetter__('recognizeTextLinks', () => Preferences.getExt("textlinks", true));
lazy(this, "ContentHandling", () => require("support/contenthandling").ContentHandling);
lazy(this, 'CoThreads', () => require("support/cothreads"));
lazy(this, 'getIcon', () => require("support/icons").getIcon);
lazy(this, "bundle", () => new (require("utils").StringBundles)(["chrome://dtm/locale/menu.properties"]));
lazy(this, "isWindowPrivate", () => require("support/pbm").isWindowPrivate);
lazy(this, "identity", () => require("support/memoize").identity);

const {filterInSitu, mapFilterInSitu} = require("utils");
const {unique} = require("support/uniquelinks");

const {unloadWindow} = require("support/overlays");
const strfn = require("support/stringfuncs");

var findLinksJob = 0;

const MENU_ITEMS = [
	'SepBack', 'Pref', 'SepPref', 'TDTM', 'DTM', 'TDTMSel',
	'DTMSel', 'SaveLinkT', 'SaveLink', 'SaveImgT', 'SaveImg',
	'SaveVideoT', 'SaveVideo', 'SaveAudioT', 'SaveAudio',
	'SaveFormT', 'SaveForm', 'SepFront'
	];

function makeURI(u, ml) {
	if (!u) {
		return null;
	}
	try {
		let url = Services.io.newURI(u.spec || u, u.originCharset, null);
		if (ml) {
			url = DTM.getLinkPrintMetalink(url) || url;
		}
		return new DTM.URL(url);
	}
	catch (ex) {
		log(LOG_ERROR, "failed to reconstruct: " + JSON.stringify(u), ex);
		return null;
	}
};

/* **
 * Helpers and tools
 */
function trimMore(t) {
	return identity(t.replace(/^[\s_]+|[\s_]+$/gi, '').replace(/(_){2,}/g, "_"));
}

function extractDescription(child) {
	let rv = [];
	try {
		let fmt = function(s) {
			try {
				return trimMore(s.replace(/(\n){1,}/gi, " ").replace(/(\s){2,}/gi, " "));
			}
			catch (ex) { /* no-op */ }
			return "";
		};
		for (let i = 0, e = child.childNodes.length; i < e; ++i) {
			let c = child.childNodes[i];

			if (c.nodeValue && c.nodeValue) {
				rv.push(fmt(c.nodeValue));
			}

			if (c.nodeType === 1) {
				rv.push(extractDescription(c));
			}

			if (c && 'hasAttribute' in c) {
				if (c.hasAttribute('title')) {
					rv.push(fmt(c.getAttribute('title')));
				}
				else if (c.hasAttribute('alt')) {
					rv.push(fmt(c.getAttribute('alt')));
				}
			}
		}
	}
	catch(ex) {
		log(LOG_ERROR, 'extractDescription', ex);
	}
	return trimMore(rv.join(" "));
}

const getSniffedInfo_name = /^(?:[a-f0-9]+|\d+|(?:video)playback|player)$/i;
function getSniffedInfoFromLocation(l) {
	if (!Preferences.getExt('listsniffedvideos', false)) {
		return [];
	}
	const docURI = Services.io.newURI(l.url.spec, l.url.originCharset, null);
	return ContentHandling.getSniffedVideosFor(docURI, l.isPrivate).map(function(e) {
		let [fn,ext] = strfn.getFileNameAndExt(e.spec);
		if (!ext || getSniffedInfo_name.test(fn)) {
			ext = ext || "flv";
			fn = strfn.replaceSlashes(strfn.getUsableFileName(l.title) || "unknown", "-");
		}
		return {
			url: e,
			name: fn + "." + ext,
			ref: docURI.spec
		};
	});
}

/* **
 * LOADER
 */
exports.load = function load(window, outerEvent) {
	let document = window.document;
	let setTimeoutOnlyFun = function(c, ...args) {
		if (typeof(c) !== "function") {
			throw new Error("do not call me with a string!");
		}
		return window.setTimeout.call(window, c, ...args);
	};
	let setIntervalOnlyFun = function(c, ...args) {
		if (typeof(c) !== "function") {
			throw new Error("do not call me with a string!");
		}
		return window.setInterval(c, ...args);
	};
	let clearInterval = window.clearInterval;
	let gBrowser = window.gBrowser;

	function $(...args) {
		if (args.length === 1) {
			return document.getElementById(args[0]);
		}
		let elements = [];
		for (let i = 0, e = args.length; i < e; ++i) {
			let id = args[i];
			let element = document.getElementById(id);
			if (element) {
				elements.push(element);
			}
			else {
				log(LOG_ERROR, "requested a non-existing element: " + id);
			}
		}
		return elements;
	}

	let _selector = null;

	let _notify = function (title, message, priority, mustAlert, timeout) {
		switch (Preferences.getExt("notification2", 1)) {
		/* jshint strict:true, globalstrict:true, -W086 */
		case 1:
			if ('PopupNotifications' in window) {
				try {
					timeout = timeout || 2500;
					let notification = window.PopupNotifications.show(
							gBrowser.selectedBrowser,
							'downthemoon',
							message,
							'downthemoon-notification-icon',
							null,
							null,
							{timeout: timeout}
							);
					setTimeoutOnlyFun(function() {
						window.PopupNotifications.remove(notification);
					}, timeout);
					return;
				}
				catch (ex) {
					// no op
				}
				return;
			}
			// fall through in case we got not doorhangers
		case 2:
		/* jshint strict:true, globalstrict:true, +W086 */
			require("support/alertservice")
				.show("DownTheMoon!", message, null, "chrome://dtmicon/content/icon64.png");
			return;
		default:
			// no notification
			return;
		}
	};

	function notifyError(title, message) {
		return _notify(title, message, 'PRIORITY_CRITICAL_HIGH', true, 1500);
	}
	function notifyInfo(message) {
		if (!_selector) {
			_notify('', message, 'PRIORITY_INFO_MEDIUM', false);
		}
	}

	function selectButton() {
		return $('dtm-turboselect-button') || {checked: false};
	}
	function getMethod(method, data, target, browser) {
		let b = browser || gBrowser.selectedBrowser;
		return new Promise((resolve, reject) => {
			let job = ++findLinksJob;
			let result = m => {
				b.messageManager.removeMessageListener(`DTM:${method}:${job}`, result);
				if (m.data.exception) {
					reject(m.data.exception);
				}
				else {
					resolve(m.data);
				}
			};
			b.messageManager.addMessageListener(`DTM:${method}:${job}`, result);
			if (!target) {
				b.messageManager.sendAsyncMessage(`DTM:${method}`, {job:job, args: data});
			}
			else {
				b.messageManager.sendAsyncMessage(`DTM:${method}`, {job:job, args: data}, {target:target});
			}
		});
	}
	function getCurrentLocations() {
		return getMethod("getLocations");
	}
	function getFocusedDetails() {
		return getMethod("getFocusedDetails");
	}
	function getFormData(target) {
		return getMethod("getFormData", null, target);
	}
	function findBrowsers(all) {
		let browsers = [];
		if (!all) {
			browsers.push(gBrowser.selectedBrowser);
			return browsers;
		}
		for (let e of gBrowser.browsers) {
			browsers.push(e);
		}
		return browsers;
	}

	async function findLinks(turbo, all) {
		try {
			if (!all && turbo && Preferences.getExt('rememberoneclick', false)) {
				all = Preferences.getExt('lastalltabs', false);
			}
			if (turbo && all) {
				Preferences.setExt('lastalltabs', all);
			}

			if (turbo) {
				log(LOG_INFO, "findLinks(): DtmOneClick request from the user");
			}
			else {
				log(LOG_INFO, "findLinks(): DtmStandard request from the user");
			}

			let collectedUrls = [];
			let collectedImages = [];
			let urlsLength = 0;
			let imagesLength = 0;

			// long running fetching may confuse users, hence give them a hint that
			// stuff is happening
			let intervalfunc;
			let _updateInterval = setIntervalOnlyFun(intervalfunc = (function(isStarter) {
				if (isStarter) {
					clearInterval(_updateInterval);
					_updateInterval = setIntervalOnlyFun(intervalfunc, 150, false);
				}
				if (urlsLength + imagesLength) {
					notifyProgress(bundle.getFormattedString('processing.label', [urlsLength, imagesLength]));
				}
				else {
					notifyProgress(bundle.getString('preparing.label'));
				}
			}), 1750, true);

			try {
				let promises = [];
				let job = findLinksJob++;
				for (let b of findBrowsers(all)) {
					let browser = b;
					promises.push(new Promise((resolve, reject) => {
						let progress = m => {
							urlsLength += m.data.urls;
							imagesLength += m.data.images;
						};
						let result = m => {
							browser.messageManager.removeMessageListener("DTM:findLinks:progress:" + job, progress);
							browser.messageManager.removeMessageListener("DTM:findLinks:" + job, result);
							resolve(m.data);
						};
						browser.messageManager.addMessageListener("DTM:findLinks:progress:" + job, progress);
						browser.messageManager.addMessageListener("DTM:findLinks:" + job, result);
						browser.messageManager.sendAsyncMessage("DTM:findLinks", {
							job: job,
							honorSelection: !all,
							recognizeTextLinks: recognizeTextLinks
						});
					}));
				}

				let nonnull = function(e) {
					return !!e;
				};
				let transposeURIs = function(e) {
					try {
						e.url = makeURI(e.url);
						if (!e.url) {
							return null;
						}
						e.referrer = makeURI(e.referrer);
						return e;
					}
					catch (ex) {
						return null;
					}
				};
				for (let p of promises) {
					let {urls, images, locations} = await p;
					if (!urls.length && !images.length && !locations.length) {
						continue;
					}
					collectedUrls = collectedUrls.concat(mapFilterInSitu(urls, transposeURIs, nonnull));
					collectedImages = collectedImages.concat(mapFilterInSitu(images, transposeURIs, nonnull));
					for (let l of locations) {
						let sniffed = getSniffedInfoFromLocation(l);
						for (let s of sniffed) {
							let o = {
								"url": new DTM.URL(s.url),
								"fileName": s.name,
								"referrer": s.ref,
								"description": bundle.getString('sniffedvideo')
							};
							collectedUrls.push(o);
							collectedImages.push(o);
						}
					}
				}
				unique(collectedUrls);
				for (let e of collectedUrls) {
					if (!e.description) {
						e.description = e.defaultDescription || "";
					}
					delete e.defaultDescription;
					e.description = identity(e.description);
				}

				unique(collectedImages);
				for (let e of collectedImages) {
					if (!e.description) {
						e.description = e.defaultDescription || "";
					}
					delete e.defaultDescription;
					e.description = identity(e.description);
				}

				// clean up the "hint" notification from above
				clearInterval(_updateInterval);
				notifyProgress();

				log(LOG_DEBUG, "findLinks(): finishing...");
				if (!collectedUrls.length && !collectedImages.length) {
					notifyError(bundle.getString('error'), bundle.getString('error.nolinks'));
					return;
				}

				DTM.setPrivateMode(window, collectedUrls);
				DTM.setPrivateMode(window, collectedImages);

				if (turbo) {
					DTM.turboSaveLinkArray(window, collectedUrls, collectedImages, function(queued) {
						if (!queued) {
							DTM.saveLinkArray(
								window,
								collectedUrls,
								collectedImages,
								bundle.getString('error.information')
							);
						}
						else if (typeof queued === 'number') {
							notifyInfo(bundle.getFormattedString('queuedn', [queued]));
						}
						else {
							notifyInfo(bundle.getFormattedString('queued', [queued.url]));
						}
					});
					return;
				}
				DTM.saveLinkArray(window, collectedUrls, collectedImages);
			}
			catch (ex) {
				log(LOG_ERROR, "findLinksTask", ex);
			}
		}
		catch(ex) {
			log(LOG_ERROR, 'findLinks', ex);
		}
	}

	function findSingleLink(turbo) {
		if (!window.gContextMenu.onSaveableLink) {
			return;
		}
		saveSingleLinkAsync(turbo, "a", window.gContextMenu.target);
	}

	function findSingleImg(turbo) {
		saveSingleLinkAsync(turbo, "img", window.gContextMenu.target);
	}

	function _findSingleMedia(turbo, tag) {
		saveSingleLinkAsync(turbo, tag, window.gContextMenu.target, ctx.mediaURL);
	}
	function findSingleVideo(turbo) {
		_findSingleMedia(turbo, 'video');
	}
	function findSingleAudio(turbo) {
		_findSingleMedia(turbo, 'audio');
	}

	function findSniff(event, turbo) {
		const target = event.explicitOriginalTarget;
		if (target.classList.contains("dtm-sniff-element") && target.info) {
			DTM.saveSingleItem(window, turbo, target.info);
		}
	}

	async function saveSingleLinkAsync(turbo, what, target, linkhint) {
		try {
			let data = await getMethod("saveTarget", {what:what, linkhint: linkhint}, target);
			let url = makeURI(data, true);
			if (!url) {
				throw new Error("invalid URL");
			}
			let ref = makeURI(data.ref);

			const item = {
				url: url,
				description: data.desc || trimMore(data.title || ""),
				referrer: ref,
				isPrivate: isWindowPrivate(window)
			};
			if (data.download) {
				data.download = data.download.trim();
				if (data.download) {
					item.fileName = data.download;
				}
			}
			if (turbo) {
				try {
					DTM.saveSingleItem(window, true, item);
					notifyInfo(bundle.getFormattedString('queued', [url]));
					return;
				}
				catch (ex) {
					log(LOG_ERROR, 'saveSingleLink', ex);
					notifyError(bundle.getString('error'), bundle.getString('error.information'));
				}
			}
			DTM.saveSingleItem(window, false, item);
		}
		catch (ex) {
			log(LOG_ERROR, "Failed to process single link", ex);
			notifyError(bundle.getString('error'), bundle.getString('errorcannotdownload'));
		}
	}

	async function findForm(turbo) {
		try {
			let data = await getFormData(window.gContextMenu.target);

			let action = makeURI(data);
			if (!action) {
				throw new Error("Invalid Form URL");
			}

			if (data.method === 'post') {
				let ss = new Instances.StringInputStream(data.values, -1);
				let ms = new Instances.MimeInputStream();
				ms.addContentLength = true;
				ms.addHeader('Content-Type', 'application/x-www-form-urlencoded');
				ms.setData(ss);

				let sis = new Instances.ScriptableInputStream(ms);
				let postData = '';
				let avail = 0;
				while ((avail = sis.available())) {
					postData += sis.read(avail);
				}
				sis.close();
				ms.close();
				ss.close();

				action.postData = postData;
			}
			else {
				action.url.query = data.values;
				action.url.ref = '';
			}

			let ref = makeURI(data.ref);
			let defaultDescription = trimMore(data.title || "");
			let desc = data.desc || defaultDescription;

			let item = {
				"url": action,
				"referrer": ref,
				"description": desc,
				"isPrivate": isWindowPrivate(window)
			};

			if (turbo) {
				try {
					DTM.saveSingleItem(window, true, item);
					return;
				}
				catch (ex) {
					log(LOG_ERROR, 'findSingleLink', ex);
					notifyError(bundle.getString('error'), bundle.getString('error.information'));
				}
			}
			DTM.saveSingleItem(window, false, item);
		}
		catch (ex) {
			log(LOG_ERROR, 'findForm', ex);
		}
	}

	let notifyProgress = function(message) {
		try {
			let _n = null;
			if ('PopupNotifications' in window) {
				notifyProgress = function(message) {
					if (!Preferences.getExt("notification2", 1) !== 1) {
						return;
					}
					if (!message && _n) {
						window.PopupNotifications.remove(_n);
						_n = null;
						return;
					}
					if (!message) {
						return;
					}
					_n = window.PopupNotifications.show(
						gBrowser.selectedBrowser,
						'downthemoon',
						message,
						'downthemoon-notification-icon'
						);
				};
				return notifyProgress(message);
			}
			notifyProgress = function() {};;
			return notifyProgress();
		}
		catch (ex) {
			log(LOG_ERROR, "np", ex);
			notifyProgress = function() {};
		}
	};

	function saveSelected(m) {
		try {
			let data = m.data;
			let url = makeURI(data, true);
			if (!url) {
				throw new Error("Invalid selected URL");
			}

			let ref = makeURI(data.ref);
			const item = {
				url: url,
				description: data.desc || trimMore(data.title || ""),
				referrer: ref,
				isPrivate: isWindowPrivate(window)
			};
			if (data.download) {
				data.download = data.download.trim();
				if (data.download) {
					item.fileName = data.download;
				}
			}
			try {
				DTM.saveSingleItem(window, true, item);
				notifyInfo(bundle.getFormattedString('queued', [url]));
				return;
			}
			catch (ex) {
				log(LOG_ERROR, 'saveSingleLink', ex);
				notifyError(bundle.getString('error'), bundle.getString('error.information'));
			}
			DTM.saveSingleItem(window, false, item);
		}
		catch (ex) {
			log(LOG_ERROR, "Failed to process single link", ex);
			notifyError(bundle.getString('error'), bundle.getString('errorcannotdownload'));
		}
	}

	function newFrameScript(m) {
		if (selectButton().checked) {
			attachOneClick();
		}
	}

	window.messageManager.addMessageListener("DTM:selected", saveSelected);
	window.messageManager.addMessageListener("DTM:new", newFrameScript);
	unloadWindow(window, () => {
		window.messageManager.removeMessageListener("DTM:selected", saveSelected);
		window.messageManager.removeMessageListener("DTM:new", newFrameScript);
	});

	// these are only valid after the load event.
	let direct = {};
	let compact = {};
	let tools = {};

	let ctxBase = $('dtmCtxCompact');
	let toolsBase = $('dtmToolsMenu');
	let toolsMenu = $('dtmToolsPopup');
	let toolsSep = $('dtmToolsSep');

	let ctx = ctxBase.parentNode;
	let menu = toolsBase.parentNode;

	function onContextShowing(evt) {
		try {
			let ctx = window.gContextMenu;
			let ctxdata = window.gContextMenuContentData;
			// get settings
			let items = Preferences.getExt("ctxmenu", "1,1,0").split(",").map(e => parseInt(e, 10));
			let showCompact = Preferences.getExt("ctxcompact", false);

			let menu;
			if (showCompact) {
				ctxBase.hidden = false;
				menu = compact;
			}
			else {
				ctxBase.hidden = true;
				menu = direct;
			}

			// hide all
			for (let i in menu) {
				direct[i].hidden = true;
				compact[i].hidden = true;
			}
			// show nothing!
			if (items.indexOf(1) === -1) {
				ctxBase.hidden = true;
				return;
			}

			// setup menu items
			// show will hold those that will be shown
			let show = [];

			let sel = ctx && ctx.isContentSelected;
			if (sel) {
				if (items[0]) {
					show.push(menu.DTMSel);
				}
				if (items[1]) {
					show.push(menu.TDTMSel);
				}
			}

			// hovering an image or link
			if (ctx && (ctx.onLink || ctx.onImage || ctx.onVideo || ctx.onAudio)) {
				if (items[0]) {
					if (ctx.onLink) {
						show.push(menu.SaveLink);
					}
					if (ctx.onImage) {
						show.push(menu.SaveImg);
					}
					if (ctx.onVideo) {
						show.push(menu.SaveVideo);
					}
					if (ctx.onAudio) {
						show.push(menu.SaveAudio);
					}
				}
				if (items[1]) {
					if (ctx.onLink) {
						show.push(menu.SaveLinkT);
					}
					if (ctx.onImage) {
						show.push(menu.SaveImgT);
					}
					if (ctx.onVideo) {
						show.push(menu.SaveVideoT);
					}
					if (ctx.onAudio) {
						show.push(menu.SaveAudioT);
					}
				}
			}
			else if (ctxdata && ctxdata.addonInfo && ctxdata.addonInfo["DTM:onform"]) {
				if (items[0]) {
					show.push(menu.SaveForm);
				}
				if (items[1]) {
					show.push(menu.SaveFormT);
				}
			}
			// regular
			else if (!sel) {
				if (items[0]) {
					show.push(menu.DTM);
				}
				if (items[1]) {
					show.push(menu.TDTM);
				}
			}

			// prefs
			if (items[2]) {
				show.push(menu.Pref);
				if (compact && (items[0] || items[1])) {
					show.push(menu.SepPref);
				}
			}

			// show the seperators, if required.
			let n = menu.SepFront;
			while ((n = n.previousSibling)) {
				if (n.hidden) {
					continue;
				}
				if (n.nodeName !== 'menuseparator') {
					show.push(menu.SepFront);
				}
				break;
			}
			n = menu.SepBack;
			while ((n = n.nextSibling)) {
				if (n.hidden) {
					continue;
				}
				if (n.nodeName !== 'menuseparator') {
					show.push(menu.SepBack);
				}
				break;
			}
			for (let node of show) {
				node.hidden = false;
			}
		}
		catch(ex) {
			log(LOG_ERROR, "DTMContext(): ", ex);
		}
	}

	function onToolsShowing(evt) {
		try {

			// get settings
			let menu = Preferences.getExt("toolsmenu", "1,1,1").split(",").map(e => parseInt(e, 10));

			// all hidden...
			let hidden = Preferences.getExt("toolshidden", false);
			for (let i in tools) {
				tools[i].hidden = hidden;
			}
			toolsBase.hidden = hidden;
			if (hidden) {
				return;
			}

			let compact = menu.indexOf(0) !== -1;

			// setup menu items
			// show will hold those that will be shown
			let show = [];

			if (menu[0]) {
				show.push('DTM');
			}
			if (menu[1]) {
				show.push('TDTM');
			}
			// prefs
			if (menu[2]) {
				show.push('Manager');
			}
			toolsSep.hidden = menu.indexOf(0) === -1;
			toolsBase.setAttribute('label',
				bundle.getString(menu.indexOf(1) !== -1 ? 'moredtmtools' : 'simpledtmtools'));

			// show the items.
			for (let i in tools) {
				let cur = tools[i];
				if (show.indexOf(i) === -1) {
					toolsMenu.insertBefore(cur, toolsSep);
				}
				else {
					toolsBase.parentNode.insertBefore(cur, toolsBase);
				}
			}
		}
		catch(ex) {
			log(LOG_ERROR, "DTMTools(): ", ex);
		}
	}

	async function onDTMShowing(evt) {
		let menu = evt.target;
		for (let n of menu.querySelectorAll(".dtm-sniff-element")) {
			n.parentNode.removeChild(n);
		}
		if (!Preferences.getExt('listsniffedvideos', false)) {
			return;
		}
		const locations = await getCurrentLocations();
		let sniffed = [];
		for (let l of locations) {
			sniffed = sniffed.concat(getSniffedInfoFromLocation(l));
		}
		if (!sniffed.length) {
			return;
		}

		let sep = document.createElement("menuseparator");
		sep.className = "dtm-sniff-element";
		menu.appendChild(sep);

		let cmd = menu.parentNode.getAttribute("buttoncommand") + "-sniff";
		for (let s of sniffed) {
			let o = {
				"url": new DTM.URL(s.url),
				"referrer": s.ref,
				"fileName": s.name,
				"description": bundle.getString("sniffedvideo"),
				"isPrivate": isWindowPrivate(window)
			};
			let mi = document.createElement("menuitem");
			mi.setAttribute("label", strfn.cropCenter(s.name, 60));
			mi.setAttribute("tooltiptext", o.url.spec);
			mi.setAttribute("image", getIcon(s.name));
			mi.setAttribute("command", cmd);
			mi.info = o;
			mi.className = "dtm-sniff-element menuitem-iconic";
			menu.appendChild(mi);
		}
	}

	async function onDTMViewShowing(button, view) {
		for (let n of view.querySelectorAll(".dtm-sniff-element")) {
			n.parentNode.removeChild(n);
		}
		if (!Preferences.getExt('listsniffedvideos', false)) {
			return;
		}
		const locations = await getCurrentLocations();
		let sniffed = [];
		for (let l of locations) {
			sniffed = sniffed.concat(getSniffedInfoFromLocation(l));
		}
		if (!sniffed.length) {
			return;
		}

		let menu = view.querySelector(".panel-subview-body");

		let sep = document.createElement("menuseparator");
		sep.className = "dtm-sniff-element";
		menu.appendChild(sep);

		let cmd = button.getAttribute("buttoncommand") + "-sniff";
		for (let s of sniffed) {
			let o = {
				"url": new DTM.URL(s.url),
				"referrer": s.ref,
				"fileName": s.name,
				"description": bundle.getString("sniffedvideo"),
				"isPrivate": isWindowPrivate(window)
			};
			let mi = document.createElement("toolbarbutton");
			mi.setAttribute("label", strfn.cropCenter(s.name, 60));
			mi.setAttribute("tooltiptext", o.url.spec);
			mi.setAttribute("image", getIcon(s.name));
			mi.setAttribute("command", cmd);
			mi.info = o;
			mi.className = "dtm-sniff-element subviewbutton cui-withicon";
			menu.appendChild(mi);
		}
	}

	function attachOneClick() {
		window.messageManager.broadcastAsyncMessage("DTM:selector", {
			enable: true,
			bgimgs: Preferences.getExt('selectbgimages', false)
		});
	}

	function detachOneClick() {
		window.messageManager.broadcastAsyncMessage("DTM:selector", {enable: false});
	}

	let _keyActive =  false;
	function onKeyDown(evt) {
		return; // XXX reenable when polished
		/*if (_keyActive) {
			return;
		}
		if (evt.shiftKey && evt.ctrlKey) {
			_keyActive = true;
			selectButton().checked = true;
			attachOneClick();
		}*/
	}
	function onKeyUp(evt) {
		return; // XXX reenable when polished
		/*if (!_keyActive) {
			return;
		}
		if (evt.shiftKey) {
			_keyActive = false;
			selectButton().checked = false;
			detachOneClick();
		}*/
	}
	function onToolbarInstall(event) {
		// white list good locations
		// note that this is only performed to keep the number of event listeners down
		// The remote site does not get special privileges!
		try {
			if (!/^about:downthemoon/.test(event.target.location) &&
				event.target.location.host !== "about.downthemoon.nope") {
				return;
			}
		}
		catch (ex) {
			// might be another location where there is no .host
			return;
		}
		let tbinstall, tbunload, win = event.target;
		win.addEventListener("DTM:toolbarinstall", tbinstall = (function() {
			win.removeEventListener("DTM:toolbarinstall", tbinstall, true);
			win.removeEventListener("unload", tbunload, true);
			Mediator.showToolbarInstall(window);
		}), true);
		win.addEventListener("unload", tbunload = (function() {
			win.removeEventListener("DTM:toolbarinstall", tbinstall, true);
			win.removeEventListener("unload", tbunload, true);
		}), true);
	}

	function onBlur(evt) {
		return; // XXX reenable when polished
		/*// when the window loses focus the keyup might not be received.
		// better toggle back
		if (!_keyActive) {
			return;
		}
		_keyActive = false;
		selectButton().checked = false;
		detachOneClick();
		*/
	}

	function toggleOneClick() {
		if (selectButton().checked) {
			attachOneClick();
		}
		else {
			detachOneClick();
		}
	}


	function setupDrop(elem, func) {
		function ondragover(event) {
			try {
				if (event.dataTransfer.types.contains("text/x-moz-url")) {
					event.dataTransfer.dropEffect = "link";
					event.preventDefault();
				}
			}
			catch (ex) {
				log(LOG_ERROR, "failed to process ondragover", ex);
			}
		}
		async function ondrop(event) {
			try {
				let url = event.dataTransfer.getData("URL");
				if (!url) {
					return;
				}
				url = Services.io.newURI(url, null, null);
				url = new DTM.URL(DTM.getLinkPrintMetalink(url) || url);
				let {ref, title} = await getFocusedDetails();
				ref = makeURI(ref);
				func(url, ref);
			}
			catch (ex) {
				log(LOG_ERROR, "failed to process ondrop", ex);
			}
		}
		elem.addEventListener("dragover", ondragover, true);
		elem.addEventListener("drop", ondrop, true);
		unloadWindow(window, function() {
			elem.removeEventListener("dragover", ondragover, true);
			elem.removeEventListener("drop", ondrop, true);
		});
	}

	function $t(...args) {
		let rv = [];
		for (let i = 0, e = args.length; i < e; ++i) {
			let id = args[i];
			let element = document.getElementById(id);
			if (element) {
					rv.push(element);
					continue;
			}
			if (id in paletteItems) {
				rv.push(paletteItems[id]);
				continue;
			}
		}
		return rv.length === 1 ? rv[0] : rv;
	}

	(function initMenusAndCommands(evt) {
		function bindEvt(evt, fn) {
			return function (e) {
				e.addEventListener(evt, fn, true);
				unloadWindow(window, () => e.removeEventListener(evt, fn, true));
			};
		}

		try {
			let cont = $('dtmCtxSubmenu');

			for (let id of MENU_ITEMS) {
				compact[id] = $('dtmCtx' + id);
				let node = $('dtmCtx' + id).cloneNode(true);
				node.setAttribute('id', node.id + "-direct");
				ctx.insertBefore(node, ctxBase.nextSibling);
				direct[id] = node;
				unloadWindow(window, () => node.parentNode.removeChild(node));
			}

			// prepare tools
			for (let e of ['DTM', 'TDTM', 'Manager']) {
				tools[e] = $('dtmTools' + e);
			}

			let f = bindEvt("command", () => findLinks(false));
			f($("dtm:regular"));
			f($("dtm:regular-sel"));
			bindEvt("command", () => findLinks(false, true))($("dtm:regular-all"));
			bindEvt("command", () => findSingleLink(false))($("dtm:regular-link"));
			bindEvt("command", () => findSingleImg(false))($("dtm:regular-img"));
			bindEvt("command", () => findSingleVideo(false))($("dtm:regular-video"));
			bindEvt("command", () => findSingleAudio(false))($("dtm:regular-audio"));
			bindEvt("command", () => findForm(false))($("dtm:regular-form"));
			bindEvt("command", e => findSniff(e, false))($("dtm:regular-sniff"));

			f = bindEvt("command", () => findLinks(true));
			f($("dtm:turbo"));
			f($("dtm:turbo-sel"));
			bindEvt("command", () => findLinks(true, true))($("dtm:turbo-all"));
			bindEvt("command", () => findSingleLink(true))($("dtm:turbo-link"));
			bindEvt("command", () => findSingleImg(true))($("dtm:turbo-img"));
			bindEvt("command", () => findSingleVideo(true))($("dtm:turbo-video"));
			bindEvt("command", () => findSingleAudio(true))($("dtm:turbo-audio"));
			bindEvt("command", () => findForm(true))($("dtm:turbo-form"));
			bindEvt("command", e => findSniff(e, true))($("dtm:turbo-sniff"));

			bindEvt("command", () => toggleOneClick())($("dtm:turboselect"));
			bindEvt("command", () => DTM.openManager(window))($("dtm:manager"));
			bindEvt("command", () => Mediator.showPreferences(window))($("dtm:prefs"));
			bindEvt("command", () => Mediator.showToolbarInstall(window))($("dtm:tbinstall"));
			bindEvt("command", () => Mediator.showAbout(window))($("dtm:about"));

			bindEvt("popupshowing", onContextShowing)(ctx);
			bindEvt("popupshowing", onToolsShowing)(menu);
		}
		catch (ex) {
			Components.utils.reportError(ex);
			log(LOG_ERROR, "DCO::init()", ex);
		}
	})();

	/*window.addEventListener("keydown", onKeyDown, false);
	unloadWindow(window, function() window.removeEventListener("keydown", onKeyDown, false));

	window.addEventListener("keyup", onKeyUp, false);
	unloadWindow(window, function() window.removeEventListener("keyup", onKeyUp, false));

	window.addEventListener("blur", onBlur, true);
	unloadWindow(window, function() window.removeEventListener("blur", onBlur, true));*/

	let appcontent = document.getElementById("appcontent");
	if (appcontent) {
		appcontent.addEventListener("DOMContentLoaded", onToolbarInstall, true);
		unloadWindow(window, () => appcontent.removeEventListener("DOMContentLoaded", onToolbarInstall, true));
	}

	/* Toolbar buttons */

	// Santas little helper, palette items + lookup
	let paletteItems = {};
	try {
		let palette = $('navigator-toolbox').palette;
		for (let c = palette.firstChild; c; c = c.nextSibling) {
			if (c.id) {
				paletteItems[c.id] = c;
			}
		}
	}
	catch (ex) {
		log(LOG_ERROR, "Failed to parse palette", ex);
	}

	try {
		(function() {
			function onCommand(e) {
				let el = e.target;
				if (el.getAttribute("cui-areatype") === "menu-panel") {
					try {
						let ownerWindow = el.ownerDocument.defaultView;
						let {area} = ownerWindow.CustomizableUI.getPlacementOfWidget(el.id);
						let view = el.getAttribute("panelview");
						onDTMViewShowing(el, $(view));
						ownerWindow.PanelUI.showSubView(view, el, area);
						e.preventDefault();
						return false;
					}
					catch (ex) {
						log(LOG_ERROR, "failed to show panel", ex);
					}
				}
				$(el.getAttribute("buttoncommand")).doCommand();
			}
			let dtm_button = $t('dtm-button');
			dtm_button.addEventListener('popupshowing', onDTMShowing, true);
			unloadWindow(window, () => dtm_button.removeEventListener('popupshowing', onDTMShowing, true));
			dtm_button.addEventListener('command', onCommand, true);
			unloadWindow(window, () => dtm_button.removeEventListener('command', onCommand, true));

			setupDrop(dtm_button, function(url, ref) {
				DTM.saveSingleItem(window, false, {
					"url": url,
					"referrer": ref,
					"description": "",
					"isPrivate": isWindowPrivate(window)
				});
			});

			let dtm_turbo_button = $t('dtm-turbo-button');
			dtm_turbo_button.addEventListener('popupshowing', onDTMShowing, true);
			unloadWindow(window, () => dtm_turbo_button.removeEventListener('popupshowing', onDTMShowing, true));
			dtm_turbo_button.addEventListener('command', onCommand, true);
			unloadWindow(window, () => dtm_turbo_button.removeEventListener('command', onCommand, true));

			setupDrop(dtm_turbo_button, function(url, ref) {
				let item = {
					"url": url,
					"referrer": ref,
					"description": "",
					"isPrivate": isWindowPrivate(window)
				};
				try {
					DTM.saveSingleItem(window, true, item);
				}
				catch (ex) {
					log(LOG_ERROR, "failed to turbo drop, retrying normal", ex);
					DTM.saveSingleItem(window, false, item);
				}
			});

			unloadWindow(window, () => detachOneClick());
		})();
	}
	catch (ex) {
		log(LOG_ERROR, "Init TBB failed", ex);
	}

	if (outerEvent) {
		log(LOG_DEBUG, "replaying event");
		let target = outerEvent.target;
		let type = outerEvent.type;
		if (type === "popupshowing") {
			switch(target.id) {
				case "menu_ToolsPopup":
					onToolsShowing(outerEvent);
					break;
				case "contentAreaContextMenu":
					onContextShowing(outerEvent);
					break;
				default:
					log(LOG_DEBUG, "dispatching new event");
					let replayEvent = document.createEvent("Events");
					replayEvent.initEvent(type, true, true);
					target.dispatchEvent(replayEvent);
					break;
			}
		}
		else if (type === "command" && target.id !== "cmd_CustomizeToolbars") {
			target.doCommand();
		}
	}
	log(LOG_DEBUG, "dTm integration done");
};
