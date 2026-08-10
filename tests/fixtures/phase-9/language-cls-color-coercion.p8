pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function _init()
 cls("")
 cls("3")
 poke(0x5000,pget(0,0),pget(127,127))
end
function _update() end
function _draw() end
