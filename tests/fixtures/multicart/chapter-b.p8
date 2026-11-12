pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 local p=stat(6)
 poke(0x5000,#p)
 for i=1,#p do
  poke(0x5000+i,ord(p,i))
 end
end

function _draw()
 cls(2)
 print(stat(6),8,8,7)
end
