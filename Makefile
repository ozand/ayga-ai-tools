.PHONY: test package

test:
	npm test

package:
	node utils/package.js
