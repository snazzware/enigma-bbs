/* jslint node: true */
'use strict';

var TextView		= require('./text_view.js').TextView;
var miscUtil		= require('./misc_util.js');
var strUtil			= require('./string_util.js');
var util			= require('util');
var assert			= require('assert');

exports.EditTextView	= EditTextView;

function EditTextView(client, options) {
	options.acceptsFocus = miscUtil.valueWithDefault(options.acceptsFocus, true);
	options.acceptsInput = miscUtil.valueWithDefault(options.acceptsInput, true);

	TextView.call(this, client, options);

	this.clientBackspace = function() {
		this.client.term.write('\b \b');
	};
}

util.inherits(EditTextView, TextView);

EditTextView.prototype.onKeyPress = function(key, isSpecial) {	
	if(isSpecial) {
		return;
	}

	assert(1 === key.length);

	console.log('key: ' + key);

	if(this.text.length < this.options.maxLength) {
		key = strUtil.stylizeString(key, this.textStyle);

		this.text += key;

		if(this.textMaskChar) {
			this.client.term.write(this.textMaskChar);
		} else {
			this.client.term.write(key);
		}
	}

	EditTextView.super_.prototype.onKeyPress.call(this, key, isSpecial);
};

EditTextView.prototype.onSpecialKeyPress = function(keyName) {
	//	:TODO: handle 'enter' & others for multiLine

	if(this.isSpecialKeyMapped('backspace', keyName)) {
		if(this.text.length > 0) {
			this.text = this.text.substr(0, this.text.length - 1);
			this.clientBackspace();
		}
	}

	EditTextView.super_.prototype.onSpecialKeyPress.call(this, keyName);
};