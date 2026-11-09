import test from 'node:test';import assert from 'node:assert/strict';
import {matchesOverviewFilters as match} from '../public/overview-filters.js';
const row={channels:{fba:{state:'active'},merchant:{state:'inactive'}},badges:['parallel','container'],attention:[]};
test('intersection supports simultaneous FBA, linked listing and container',()=>{assert.equal(match(row,['channel-fba','parallel','container']),true);assert.equal(match(row,['channel-fba','home']),false);});
test('union includes either channel, while inactive is not active',()=>{assert.equal(match(row,['channel-merchant','parallel'],'any'),true);assert.equal(match(row,['channel-merchant']),false);assert.equal(match(row,['channel-none']),false);});
test('empty and obsolete filters do not hide all goods; unknown status is not unlisted',()=>{assert.equal(match(row,[]),true);assert.equal(match(row,['obsolete']),true);assert.equal(match({channels:{},badges:[]},['channel-none']),false);});
