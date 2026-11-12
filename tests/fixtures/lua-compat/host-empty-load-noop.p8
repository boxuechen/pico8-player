pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function _init()
 local result=load(stat(6))
 poke(0x5000,result==nil and 1 or 0)
end
function _update() end
function _draw() cls(3) end
