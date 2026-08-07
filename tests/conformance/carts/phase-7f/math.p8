pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
-- project-authored phase 7f q16.16 math probe
-- manual: math / number format and quirks
local out=0x5200

function put4(v)
 poke4(out,v)
 out+=4
end

function _init()
 put4(max(-2,3))
 put4(min(-2,3))
 put4(mid(10,5,7))
 put4(flr(4.1))
 put4(flr(-2.3))
 put4(ceil(4.1))
 put4(ceil(-2.3))
 put4(cos(0))
 put4(cos(0.25))
 put4(sin(0.25))
 put4(sin(0.75))
 put4(atan2(0,-1))
 put4(sqrt(9))
 put4(sqrt(-1))
 put4(abs(-2.5))
 put4(abs(0x8000))
 put4(sgn(-0.1))
 put4(sgn(0))

 -- p8 math functions coerce missing/non-number inputs to zero
 put4(max(nil,2))
 put4(min(nil,2))
 put4(abs({}))
 put4(sgn({}))
end

function _update60() end

function _draw()
 memcpy(0x6000,0x5200,88)
end
