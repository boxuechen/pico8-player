pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 loaded=cartdata("phase3h_store")
 count=flr(dget(0))+1
 dset(0,count)
 reload(0x100,0x100,1)
 value=peek(0x100)
 if value==0 then value=20 end
 value+=1
 poke(0x100,value)
 cstore(0x100,0x100,1)
 poke(0x100,0)
 reload(0x100,0x100,1)
 poke(0x5100,count)
 poke(0x5101,peek(0x100))
 poke(0x5102,loaded and 1 or 0)
 poke(0x5103,flr(dget(1)))
end

function _update60()
 if btn(5,0) then
  dset(1,dget(1)+1)
  poke(0x5103,flr(dget(1)))
 end
end

function _draw()
 cls(1)
 for i=0,3 do pset(peek(0x5100+i)%128,i,7) end
end
