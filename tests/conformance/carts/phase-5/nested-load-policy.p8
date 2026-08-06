pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 local co=cocreate(function()
  load("chapter-b.p8","nested","nested")
 end)
 local ok,err=coresume(co)
 poke(0x5000,ok and 1 or 0)
 poke(0x5001,costatus(co)=="dead" and 1 or 0)
end
