pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
-- project-authored phase 7f raw q16.16 bitwise probe
-- manual: bitwise operations
local out=0x5200
local x=0x1234.5678
local mask=0x00ff.00ff

function put4(v)
 poke4(out,v)
 out+=4
end

function _init()
 put4(band(x,mask))
 put4(bor(x,mask))
 put4(bxor(x,mask))
 put4(bnot(x))
 put4(shl(x,4))
 put4(shr(0x8000,1))
 put4(lshr(0x8000,1))
 put4(rotl(x,8))
 put4(rotr(x,8))

 -- counts are normalized by the p8 function contract
 put4(shl(1,-1))
 put4(shr(1,-1))
 put4(lshr(1,-1))
 put4(rotl(x,40))
 put4(rotr(x,-8))
 put4(shl(x,32))
 put4(shr(0x8000,32))
 put4(lshr(0x8000,32))

 -- function forms default non-number operands to zero
 put4(band("bad",0xffff.ffff))
 put4(shl(1,"bad"))
 put4(bnot())
end

function _update60() end

function _draw()
 memcpy(0x6000,0x5200,80)
end
