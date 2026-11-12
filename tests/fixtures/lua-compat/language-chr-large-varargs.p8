pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function _init()
 for i=1,551 do poke(0x5200+i-1,i%251) end
 local value=chr(peek(0x5200,551))
 poke(0x5000,
  #value==551 and 1 or 0,
  ord(value,1)==1 and 1 or 0,
  ord(value,249)==249 and 1 or 0,
  ord(value,551)==49 and 1 or 0)
end
function _update() end
function _draw() end
