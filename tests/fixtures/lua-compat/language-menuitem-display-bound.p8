pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function _init()
 menuitem(1,"12345678901234567",function()
  poke(0x5001,1)
  return true
 end)
 poke(0x5000,1)
end
function _update() end
function _draw() end
